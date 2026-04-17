#!/usr/bin/env node

/**
 * Survey Taxonomy Classification Script
 *
 * Reads survey catalog from Snowflake (via JSON export or direct query),
 * classifies each answer option into one or more taxonomy paths using Claude,
 * and outputs results ready for Snowflake MERGE.
 *
 * Usage:
 *   node classify.js                     # Classify all unclassified rows
 *   node classify.js --force             # Reclassify everything
 *   node classify.js --dry-run           # Print results without upserting
 *   node classify.js --input catalog.json # Use local JSON file instead of Snowflake
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// System prompt for the AI classifier
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a taxonomy classification engine for a CRM survey system.

You assign each survey answer option to one or more hierarchical taxonomy classifications.
Each classification has two parts:

1. **bucket** — exactly one of these three predefined values:
   - "demographic" — attributes about who the person IS (age, location, political leaning, life stage, outlook, concerns)
   - "preference" — what they LIKE or WANT (sports teams, food, travel style, entertainment, content format)
   - "consumption" — what they BUY or USE (purchasing behavior, spending priorities, investments, products, wellness products)

2. **taxonomy_path** — a pipe-delimited hierarchy BELOW the bucket, using lowercase_snake_case.
   Variable depth (typically 2-4 levels, but can be more or fewer as appropriate).
   Examples: "sports|soccer|world_cup_2026|brazil", "political|affiliation|democrat", "wellness|supplements"

Rules:
- The bucket is a SEPARATE field. Do NOT include the bucket in the taxonomy_path.
- Use the ENTIRE POLL as context. The poll topic, question wording, and all answer options together should inform each taxonomy path. The same answer word in different polls may produce different paths.
- An answer CAN have MULTIPLE taxonomy classifications (e.g., one "preference" and one "demographic"). Only assign multiple when genuinely warranted — do not over-tag.
- Some answers should receive NO taxonomy: "Prefer not to say", "Something Else", "Other", "A different team", or similar non-informative catch-all options. Return an empty taxonomies array for these.
- Be consistent: the same concept should always use the same path segment (e.g., always "soccer" not sometimes "football").
- For team/player preferences, include the sport and context: "sports|soccer|world_cup_2026|brazil"
- For surveys that are segment variants of the same poll (e.g., segment-a, segment-b), use identical taxonomy paths since the questions and answers are the same.

Return a JSON array. Each element must have exactly these fields:
{
  "poll_id": string,
  "question_key": string,
  "option_value": string,
  "taxonomies": [
    {"bucket": "demographic"|"preference"|"consumption", "taxonomy_path": string, "confidence": float 0-1}
  ]
}

Return ONLY the JSON array, no markdown fencing or extra text.`;

// ---------------------------------------------------------------------------
// Build the user prompt from catalog data grouped by poll
// ---------------------------------------------------------------------------
function buildUserPrompt(catalogRows, existingTaxonomies) {
  // Group rows by poll_id
  const polls = new Map();
  for (const row of catalogRows) {
    const pid = row.POLL_ID;
    if (!polls.has(pid)) polls.set(pid, []);
    polls.get(pid).push(row);
  }

  // Build existing taxonomy reference
  let existingRef = "";
  if (existingTaxonomies && existingTaxonomies.length > 0) {
    const byBucket = { demographic: new Set(), preference: new Set(), consumption: new Set() };
    for (const t of existingTaxonomies) {
      const b = t.BUCKET?.toLowerCase();
      if (byBucket[b]) byBucket[b].add(t.TAXONOMY_PATH);
    }

    const sections = [];
    for (const [bucket, paths] of Object.entries(byBucket)) {
      if (paths.size > 0) {
        const sorted = [...paths].sort();
        sections.push(`${bucket}:\n${sorted.map((p) => `  - ${p}`).join("\n")}`);
      }
    }

    if (sections.length > 0) {
      existingRef = `\nHere are the taxonomy paths already in use. Reuse these categories and naming conventions wherever applicable. Do not create new paths that duplicate existing ones.\n\n${sections.join("\n\n")}\n\n---\n`;
    }
  }

  // Build per-poll blocks
  const pollBlocks = [];
  for (const [pollId, rows] of polls) {
    // Group by question within this poll
    const questions = new Map();
    for (const r of rows) {
      const qk = r.QUESTION_KEY;
      if (!questions.has(qk)) {
        questions.set(qk, { text: r.QUESTION_TEXT, options: [] });
      }
      questions.get(qk).options.push({
        value: r.OPTION_VALUE,
        label: r.OPTION_LABEL,
      });
    }

    let block = `Survey: ${pollId}\n`;
    let qNum = 1;
    for (const [qKey, qData] of questions) {
      const qText = qData.text?.trim() ? `"${qData.text.trim()}"` : "(no question text — infer from poll context and answer options)";
      block += `  Q${qNum} [${qKey}]: ${qText}\n`;
      block += `    Options:\n`;
      for (const opt of qData.options) {
        const label = opt.label !== opt.value ? ` (${opt.label})` : "";
        block += `      - ${opt.value}${label}\n`;
      }
      qNum++;
    }
    pollBlocks.push(block);
  }

  return `${existingRef}Classify each answer option in the following surveys. Use the full poll context (topic, questions, answer options) to inform each taxonomy path.\n\n${pollBlocks.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Call Claude API for classification
// ---------------------------------------------------------------------------
async function classifyWithClaude(catalogRows, existingTaxonomies) {
  const client = new Anthropic();
  const userPrompt = buildUserPrompt(catalogRows, existingTaxonomies);

  console.error(`Sending ${catalogRows.length} catalog rows across ${new Set(catalogRows.map((r) => r.POLL_ID)).size} polls to Claude...`);

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Parse JSON response (strip markdown fencing if present)
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");
  const results = JSON.parse(cleaned);

  return results;
}

// ---------------------------------------------------------------------------
// Flatten AI results into rows for Snowflake
// ---------------------------------------------------------------------------
function flattenResults(aiResults) {
  const rows = [];
  for (const item of aiResults) {
    if (!item.taxonomies || item.taxonomies.length === 0) continue;
    for (const t of item.taxonomies) {
      if (!t.taxonomy_path) continue;
      const levels = t.taxonomy_path.split("|");
      rows.push({
        poll_id: item.poll_id,
        question_key: item.question_key,
        option_value: item.option_value,
        bucket: t.bucket,
        taxonomy_path: t.taxonomy_path,
        taxonomy_depth: levels.length,
        taxonomy_levels: levels,
        confidence: t.confidence,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Generate MERGE SQL for Snowflake upsert
// ---------------------------------------------------------------------------
function generateMergeSql(flatRows) {
  const jsonData = JSON.stringify(flatRows);

  return `MERGE INTO MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY AS tgt
USING (
    SELECT
        s.value:poll_id::STRING        AS POLL_ID,
        s.value:question_key::STRING   AS QUESTION_KEY,
        s.value:option_value::STRING   AS OPTION_VALUE,
        s.value:bucket::STRING         AS BUCKET,
        s.value:taxonomy_path::STRING  AS TAXONOMY_PATH,
        s.value:taxonomy_depth::INTEGER AS TAXONOMY_DEPTH,
        s.value:taxonomy_levels        AS TAXONOMY_LEVELS,
        s.value:confidence::FLOAT      AS CONFIDENCE
    FROM TABLE(FLATTEN(INPUT => PARSE_JSON('${jsonData.replace(/'/g, "''")}'))) s
) AS src
ON  tgt.POLL_ID       = src.POLL_ID
AND tgt.QUESTION_KEY  = src.QUESTION_KEY
AND tgt.OPTION_VALUE  = src.OPTION_VALUE
AND tgt.BUCKET        = src.BUCKET
AND tgt.TAXONOMY_PATH = src.TAXONOMY_PATH
WHEN MATCHED THEN UPDATE SET
    tgt.TAXONOMY_DEPTH  = src.TAXONOMY_DEPTH,
    tgt.TAXONOMY_LEVELS = src.TAXONOMY_LEVELS,
    tgt.CONFIDENCE      = src.CONFIDENCE,
    tgt.UPDATED_AT      = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (POLL_ID, QUESTION_KEY, OPTION_VALUE, BUCKET, TAXONOMY_PATH, TAXONOMY_DEPTH, TAXONOMY_LEVELS, CONFIDENCE)
    VALUES (src.POLL_ID, src.QUESTION_KEY, src.OPTION_VALUE, src.BUCKET, src.TAXONOMY_PATH, src.TAXONOMY_DEPTH, src.TAXONOMY_LEVELS, src.CONFIDENCE);`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const inputIdx = args.indexOf("--input");
  const inputFile = inputIdx >= 0 ? args[inputIdx + 1] : null;

  // Load catalog data
  let catalogRows;
  if (inputFile) {
    console.error(`Loading catalog from ${inputFile}...`);
    catalogRows = JSON.parse(readFileSync(inputFile, "utf-8"));
  } else {
    console.error("No --input file provided. Please provide a JSON export of DIM_SURVEY_CATALOG.");
    console.error("Query: SELECT POLL_ID, QUESTION_KEY, QUESTION_TEXT, OPTION_VALUE, OPTION_LABEL FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_CATALOG ORDER BY POLL_ID, QUESTION_KEY");
    process.exit(1);
  }

  console.error(`Loaded ${catalogRows.length} catalog rows`);

  // Load existing taxonomies for context (if available)
  let existingTaxonomies = [];
  const existingIdx = args.indexOf("--existing");
  if (existingIdx >= 0) {
    const existingFile = args[existingIdx + 1];
    console.error(`Loading existing taxonomies from ${existingFile}...`);
    existingTaxonomies = JSON.parse(readFileSync(existingFile, "utf-8"));
    console.error(`Loaded ${existingTaxonomies.length} existing taxonomy rows`);
  }

  // Filter out already-classified rows (unless --force)
  if (!force && existingTaxonomies.length > 0) {
    const classifiedKeys = new Set(
      existingTaxonomies.map((t) => `${t.POLL_ID}|${t.QUESTION_KEY}|${t.OPTION_VALUE}`)
    );
    const before = catalogRows.length;
    catalogRows = catalogRows.filter(
      (r) => !classifiedKeys.has(`${r.POLL_ID}|${r.QUESTION_KEY}|${r.OPTION_VALUE}`)
    );
    console.error(`Filtered to ${catalogRows.length} unclassified rows (${before - catalogRows.length} already classified)`);
  }

  if (catalogRows.length === 0) {
    console.error("No rows to classify. Use --force to reclassify everything.");
    process.exit(0);
  }

  // Classify with Claude
  const aiResults = await classifyWithClaude(catalogRows, existingTaxonomies);
  const flatRows = flattenResults(aiResults);

  console.error(`\nClassification complete: ${flatRows.length} taxonomy assignments from ${catalogRows.length} answer options`);

  // Summary
  const bucketCounts = {};
  for (const r of flatRows) {
    bucketCounts[r.bucket] = (bucketCounts[r.bucket] || 0) + 1;
  }
  console.error("\nBucket distribution:");
  for (const [bucket, count] of Object.entries(bucketCounts).sort()) {
    console.error(`  ${bucket}: ${count}`);
  }

  const skipped = aiResults.filter((r) => !r.taxonomies || r.taxonomies.length === 0);
  console.error(`Skipped (no taxonomy): ${skipped.length} answers`);

  if (dryRun) {
    // Output results as JSON to stdout
    console.log(JSON.stringify(flatRows, null, 2));
    console.error("\n[dry-run] Results written to stdout. No Snowflake upsert.");
  } else {
    // Write results JSON and MERGE SQL
    const outFile = "taxonomy_results.json";
    const sqlFile = "taxonomy_merge.sql";
    writeFileSync(outFile, JSON.stringify(flatRows, null, 2));
    writeFileSync(sqlFile, generateMergeSql(flatRows));
    console.error(`\nResults written to ${outFile}`);
    console.error(`MERGE SQL written to ${sqlFile}`);
    console.error("Run the SQL in Snowflake to upsert the taxonomy data.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
