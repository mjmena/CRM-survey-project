// Issue #7, Module 4 — pure row-transform for the "Responses + Demographics" tab.
//
// Lives in a sibling module (not entry.js) because a Pipedream code step may only
// `export default` — named exports in the step file break the deploy ("Unexpected
// token 'export'"). entry.js imports these; vitest imports them directly
// (transform.test.js). This is the PRD's prime unit-test target (story 17). Pure:
// no Snowflake, no Sheets, no clock.
//
// The transform turns V_SURVEY_RESPONSE_DEMOGRAPHICS rows (one per response) into a
// per-Poll 2D grid [header, ...dataRows].

// Response/identity meta columns: [header label, row key].
export const META_COLUMNS = [
  ["Response ID", "INGESTION_ID"],
  ["Submitted At", "SUBMITTED_AT"],
  ["Market", "MARKET_NAME"],
  ["Identity Source", "IDENTITY_SOURCE"],
];

// The fixed, non-identifying demographic contract — mirrors V_RESPONDENT_DEMOGRAPHICS.
// Order and membership are load-bearing: the Sheet header IS this contract.
export const DEMOGRAPHIC_COLUMNS = [
  ["Age Band", "AGE_BAND"],
  ["Generation", "GENERATION"],
  ["Household Income", "INCOME_HH"],
  ["Net Worth", "NET_WORTH_HH"],
  ["Education", "EDUCATION"],
  ["Occupation", "OCCUPATION_CATEGORY"],
  ["Marital Status", "MARITAL_STATUS"],
  ["Home Owner", "HOME_OWNER"],
  ["Ethnicity", "ETHNIC_GROUP"],
  ["Has Children", "HAS_CHILDREN_HH"],
  ["Gender", "GENDER"],
  ["State", "STATE"],
  ["DMA", "DMA"],
  ["Affinity: Investor", "AFFINITY_INVESTOR"],
  ["Affinity: Homeowner", "AFFINITY_HOMEOWNER"],
];

// ANSWERS arrives as a VARIANT — a JSON string (Pipedream) or an object. Normalize.
function parseAnswers(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    if (raw.trim() === "") return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

// A single cell: blanks for null/undefined, Yes/No for booleans, arrays joined.
function fmtCell(v) {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(fmtCell).join(", ");
  return String(v);
}

// Multi-select may already be comma-joined upstream (string) or arrive as an
// array — join either way so the cell is a single readable string.
function fmtAnswer(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return String(v);
}

/**
 * Build the grid for ONE Poll's responses.
 * @param {object[]} rows rows from V_SURVEY_RESPONSE_DEMOGRAPHICS (single Poll)
 * @returns {Array[]} [header, ...dataRows]
 */
export function buildResponseGrid(rows) {
  const list = rows || [];

  // Discover the question columns from the answers objects, sorted for stability.
  const questionSet = new Set();
  const parsed = list.map((r) => {
    const ans = parseAnswers(r.ANSWERS);
    for (const q of Object.keys(ans)) questionSet.add(q);
    return ans;
  });
  const questions = [...questionSet].sort((a, b) => a.localeCompare(b));

  const header = [
    ...META_COLUMNS.map(([label]) => label),
    ...DEMOGRAPHIC_COLUMNS.map(([label]) => label),
    ...questions,
  ];

  const dataRows = list.map((r, i) => {
    const ans = parsed[i];
    return [
      ...META_COLUMNS.map(([, key]) => fmtCell(r[key])),
      ...DEMOGRAPHIC_COLUMNS.map(([, key]) => fmtCell(r[key])),
      ...questions.map((q) => fmtAnswer(ans[q])),
    ];
  });

  return [header, ...dataRows];
}

/**
 * Group V_SURVEY_RESPONSE_DEMOGRAPHICS rows by POLL_ID into per-Poll grids.
 * @param {object[]} rows all rows across Polls
 * @returns {Record<string, Array[]>} pollId -> grid
 */
export function buildResponseGrids(rows) {
  const byPoll = {};
  for (const r of rows || []) {
    (byPoll[r.POLL_ID] ??= []).push(r);
  }
  const grids = {};
  for (const [pollId, pollRows] of Object.entries(byPoll)) {
    grids[pollId] = buildResponseGrid(pollRows);
  }
  return grids;
}
