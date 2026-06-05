#!/usr/bin/env node
// Issue #7, Module 1 — refresh DIM_RESPONDENT_IDENTITY for one Poll.
//
//   node enrichment/refresh-identity.mjs <POLL_ID> [--pad <days>]
//
// Seam (a) runtime path:
//   1. read the Poll's submission range (cheap);
//   2. computeEventWindow() pads it (resolve-identity.js);
//   3. run the windowed device->USER_ID collapse in SQL (identity_candidates.sql);
//   4. resolveHem() finalizes each candidate to {hem, hemSource} (resolve-identity.js);
//   5. DELETE + batched INSERT into DIM_RESPONDENT_IDENTITY (idempotent per Poll).
// The heavy 55B-row scan never leaves SQL; the precedence/normalization rules never
// leave the unit-tested helper. Lifts into a Pipedream handoff step unchanged (ADR-0001).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeEventWindow, resolveHem } from "./resolve-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = "MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_IDENTITY";
const STG = "MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES";
const BATCH = 2000;

function snowsql(args, { input } = {}) {
  // Common flags: quiet-ish JSON suitable for parsing.
  // NB: keep headers ON — JSON output needs column names as object keys.
  const base = [
    "-o", "friendly=false",
    "-o", "timing=false",
    "-o", "output_format=json",
  ];
  return execFileSync("snowsql", [...base, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // Long-window polls (e.g. the retirement cohort segments span ~68 days) run
    // two windowed EVENTS_412949 collapses (HEM + publication); give the scan room.
    timeout: 25 * 60 * 1000,
    input,
  });
}

// snowsql may print banners/blank lines around the JSON payload; extract it.
function parseJson(out) {
  const s = out.indexOf("[");
  const e = out.lastIndexOf("]");
  if (s === -1 || e === -1 || e < s) return [];
  return JSON.parse(out.slice(s, e + 1));
}

function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function main() {
  const argv = process.argv.slice(2);
  const pollId = argv.find((a) => !a.startsWith("--"));
  const padIdx = argv.indexOf("--pad");
  const padDays = padIdx !== -1 ? Number(argv[padIdx + 1]) : 1;
  // --skip-demographics: refresh only DIM_RESPONDENT_IDENTITY, not the heavy AA
  // rebuild. Safe when nothing HEM-affecting changed (e.g. a PUBLICATION_NAME-only
  // backfill — publication lives on the identity table, keyed by INGESTION_ID, and
  // the HEM-keyed DIM_RESPONDENT_DEMOGRAPHICS is untouched). Lets a multi-poll
  // backfill skip N redundant ~150s rebuilds and do one at the end if needed.
  const skipDemographics = argv.includes("--skip-demographics");
  if (!pollId) {
    console.error("usage: refresh-identity.mjs <POLL_ID> [--pad <days>] [--skip-demographics]");
    process.exit(2);
  }

  // 1-2. submission range -> events window
  const range = parseJson(
    snowsql(["-q",
      `SELECT MIN(SUBMITTED_AT) AS MIN_SUB, MAX(SUBMITTED_AT) AS MAX_SUB, COUNT(*) AS N
       FROM ${STG} WHERE POLL_ID = ${sqlLit(pollId)}`])
  )[0];
  if (!range || Number(range.N) === 0) {
    console.error(`No responses for POLL_ID=${pollId} — nothing to refresh.`);
    process.exit(0);
  }
  if (!range.MIN_SUB || !range.MAX_SUB) {
    // Responses exist but have no submitted_at — cannot window the events scan.
    console.error(`POLL_ID=${pollId} has responses but no submitted_at; cannot window events.`);
    process.exit(1);
  }
  const win = computeEventWindow(range.MIN_SUB, range.MAX_SUB, padDays);
  console.error(`[${pollId}] ${range.N} responses, events window ${win.start}..${win.end}`);

  // 3. heavy windowed candidate collapse (in SQL)
  const candidates = parseJson(
    snowsql([
      "-o", "variable_substitution=true",
      "-f", join(HERE, "identity_candidates.sql"),
      "-D", `poll_id=${pollId}`,
      "-D", `win_start=${win.start}`,
      "-D", `win_end=${win.end}`,
    ])
  );
  console.error(`[${pollId}] ${candidates.length} candidate rows from events collapse`);

  // 4. finalize identity with the load-bearing helper
  const rows = candidates.map((c) => {
    const { hem, hemSource } = resolveHem({
      payloadExternalId: c.PAYLOAD_EXTERNAL_ID,
      recoveredUserId: c.RECOVERED_USER_ID,
    });
    return {
      ingestionId: Number(c.INGESTION_ID),
      deviceId: c.DEVICE_ID ?? null,
      hem,
      hemSource,
      publication: c.RECOVERED_PUBLICATION ?? null, // survey-interaction publication (Market)
    };
  });

  const resolved = rows.filter((r) => r.hem).length;
  const bySource = rows.reduce((m, r) => ((m[r.hemSource ?? "unresolved"] = (m[r.hemSource ?? "unresolved"] || 0) + 1), m), {});

  // 5. idempotent write-back: DELETE this Poll, then batched INSERT
  const stmts = ["BEGIN;", `DELETE FROM ${TABLE} WHERE POLL_ID = ${sqlLit(pollId)};`];
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows.slice(i, i + BATCH).map((r) =>
      `(${sqlLit(r.ingestionId)}, ${sqlLit(pollId)}, ${sqlLit(r.deviceId)}, ${sqlLit(r.hem)}, ${sqlLit(r.hemSource)}, ${sqlLit(r.publication)})`
    ).join(",\n");
    stmts.push(
      `INSERT INTO ${TABLE} (INGESTION_ID, POLL_ID, DEVICE_ID, HEM, HEM_SOURCE, PUBLICATION_NAME) VALUES\n${values};`
    );
  }
  stmts.push("COMMIT;");

  const dir = mkdtempSync(join(tmpdir(), "respident-"));
  const file = join(dir, "writeback.sql");
  writeFileSync(file, stmts.join("\n"));
  snowsql(["-f", file]);

  console.error(
    `[${pollId}] wrote ${rows.length} rows (${resolved} resolved) — ` +
    Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(", ")
  );

  if (skipDemographics) {
    console.error(`[${pollId}] --skip-demographics: leaving DIM_RESPONDENT_DEMOGRAPHICS untouched.`);
    console.error(`[${pollId}] done.`);
    return;
  }

  // Rebuild the materialized demographics table so the live AA join (a ~150s
  // 497M-row scan) runs here at refresh time, not on every Google Sheets sync.
  // Full rebuild over all resolved HEMs (cheap output); picks up this Poll's rows.
  console.error(`[${pollId}] rebuilding DIM_RESPONDENT_DEMOGRAPHICS (AA join)…`);
  snowsql(["-q",
    "CREATE OR REPLACE TABLE MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_DEMOGRAPHICS AS " +
    "SELECT * FROM MCC_RAW.MARKETING_DEV.V_RESPONDENT_DEMOGRAPHICS"]);
  console.error(`[${pollId}] done.`);
}

main();
