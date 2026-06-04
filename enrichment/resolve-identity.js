// Respondent Identity Resolution — pure rules (issue #7, Module 1).
//
// Seam (a): the heavy, windowed 55B-row events→USER_ID collapse stays in SQL
// (see migration/respondent_identity_ddl.sql, which emits ONE recovered USER_ID
// per device). This module owns only the cheap, deterministic rules that finalize
// each per-response candidate into a canonical {hem, hemSource} — so they are
// unit-testable without touching Snowflake (story 16). The refresh runner
// (refresh-identity.mjs) is the runtime path: SQL candidates -> these functions
// -> MERGE into DIM_RESPONDENT_IDENTITY. Lift-and-shifts into a Pipedream step
// unchanged when the refresh is promoted to an explicit-handoff workflow (ADR-0001).
//
// HEM = "hashed email" = SHA-256 of a lowercased email, hex-encoded. It is the
// warehouse's existing Audience Acuity join key (AUDIENCE_IDENTITY.EMAIL.SHA256).
// Both the response payload `external_id` and Amplitude events `USER_ID` carry it.

const HEM_RE = /^[0-9a-f]{64}$/;

/**
 * Normalize a raw identifier to canonical HEM form, or null if absent.
 * Lowercases and trims; empty/whitespace/null become null. Does NOT validate
 * shape — use isValidHem for that. (A non-empty-but-malformed value normalizes
 * to a non-null string so the caller can distinguish "absent" from "present but
 * unusable" and fall through accordingly.)
 */
export function normalizeHem(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  return v === "" ? null : v;
}

/** True iff value is a syntactically valid HEM (64 lowercase hex chars). */
export function isValidHem(value) {
  return typeof value === "string" && HEM_RE.test(value);
}

/**
 * Compute the Amplitude events scan window for a Poll from its submission range.
 * Pads each end by `padDays` whole days so events fired just before the first /
 * after the last submission are still in range, while keeping the 55B-row scan
 * tightly pruned (story 13). Returns inclusive 'YYYY-MM-DD' date bounds.
 *
 * Works on the date portion only (TIMESTAMP_NTZ has no zone) to avoid TZ drift.
 */
export function computeEventWindow(submittedAtMin, submittedAtMax, padDays = 1) {
  const startDay = toUtcDate(submittedAtMin);
  const endDay = toUtcDate(submittedAtMax);
  if (!startDay || !endDay) {
    throw new Error("computeEventWindow: submittedAtMin/Max must be parseable dates");
  }
  startDay.setUTCDate(startDay.getUTCDate() - padDays);
  endDay.setUTCDate(endDay.getUTCDate() + padDays);
  return { start: ymd(startDay), end: ymd(endDay) };
}

/**
 * Finalize one per-response candidate to a canonical identity.
 * Precedence: a valid payload `external_id` wins; otherwise the events-recovered
 * USER_ID; otherwise null (unresolved — the response still flows through, with
 * blank demographics downstream, per stories 9/22). A payload value that is
 * present but malformed (not a valid HEM) does NOT win — it falls through to the
 * events recovery, and only null when both fail. Never throws.
 *
 * @param {{payloadExternalId?: string|null, recoveredUserId?: string|null}} candidate
 * @returns {{hem: string|null, hemSource: 'payload'|'events'|null}}
 */
export function resolveHem({ payloadExternalId, recoveredUserId } = {}) {
  const payload = normalizeHem(payloadExternalId);
  if (isValidHem(payload)) return { hem: payload, hemSource: "payload" };

  const events = normalizeHem(recoveredUserId);
  if (isValidHem(events)) return { hem: events, hemSource: "events" };

  return { hem: null, hemSource: null };
}

// --- internal date helpers -------------------------------------------------

function toUtcDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value == null) return null;
  // Accept 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS[.fff]' — take the date part and
  // pin to UTC midnight so day arithmetic is zone-stable.
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
