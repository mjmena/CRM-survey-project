// Issue #7, Module 4 — "Responses + Demographics" row-transform step.
//
// Self-contained on purpose: the pure transform lives in THIS file (exported as
// named exports for the unit tests) rather than a sibling module, because a
// GitHub-synced Pipedream code step is not guaranteed to bundle sibling files.
// `defineComponent` is Pipedream's identity/type-hint helper, so the test-time
// shim below is behavior-identical to production.
//
// The transform turns V_SURVEY_RESPONSE_DEMOGRAPHICS rows (one per response) into a
// per-Poll 2D grid [header, ...dataRows]. Pure: no Snowflake, no Sheets, no clock.
// It is the PRD's prime unit-test target (story 17); see entry.test.js.

// Pipedream injects `defineComponent` as a declared binding at deploy time, so we
// must NOT redeclare that name (a `const defineComponent` collides → VarRedeclaration).
// Reference it via typeof (safe on an undeclared identifier, even in vitest's strict
// mode) and fall back to an identity shim under the unit tests.
const __def =
  typeof defineComponent !== "undefined" ? defineComponent : (component) => component;

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

export default __def({
  name: "Build Response + Demographics Rows",
  description: "Transforms V_SURVEY_RESPONSE_DEMOGRAPHICS rows into per-survey wide grids (one row per response, demographic + question columns) for Google Sheets",
  props: {
    response_rows: {
      type: "any",
      label: "Response Demographics Rows",
      description: "Row results from the V_SURVEY_RESPONSE_DEMOGRAPHICS query",
    },
  },
  async run({ $ }) {
    const rows = this.response_rows || [];

    if (rows.length === 0) {
      $.export("$summary", "No survey responses found");
      return { grids: {} };
    }

    const grids = buildResponseGrids(rows);

    $.export(
      "$summary",
      `Built response + demographics grids for ${Object.keys(grids).length} survey(s)`
    );
    return { grids };
  },
});
