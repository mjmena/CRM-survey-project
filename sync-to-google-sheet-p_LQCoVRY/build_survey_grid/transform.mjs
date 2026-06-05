// The single, pure row-transform for the report-one-survey worker (ADR-0003).
//
// Sibling `.mjs` helper to build_survey_grid/entry.mjs (Pipedream bundles a
// same-dir `.mjs` import; it must be a PLAIN module with no `defineComponent`).
// Unit-tested directly from test/build-survey-grid.test.js — deploy-bundled AND
// testable. Pure: no Snowflake, no Sheets, no clock (the `now` string is passed in).
//
// Produces ONE stacked tab per poll:
//   1. tally block   — per-question answer counts + %, questions in SURVEY ORDER
//   2. a separator
//   3. per-response grid — one row per respondent; columns LEAD WITH the poll
//      answers (survey order), THEN the demographic enrichment columns.

// Response/identity meta columns: [header label, row key].
export const META_COLUMNS = [
  ["Response ID", "INGESTION_ID"],
  ["Submitted At", "SUBMITTED_AT"],
  ["Market", "MARKET_NAME"], // survey-interaction publication (the device's [Guides-Surveys] publication_name), payload market_name fallback — see V_SURVEY_RESPONSE_DEMOGRAPHICS
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

// Row that separates the tally block from the per-response grid in the one tab.
export const SECTION_DIVIDER = "RESPONSES + DEMOGRAPHICS";

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
 * Canonical question order for a poll, taken from the tally rows' QUESTION_ORDER
 * (MIN answer index — the survey order). Falls back to first-seen, then by text.
 * Returns an array of QUESTION (text) strings.
 */
export function questionOrderFromTally(tallyRows) {
  const order = new Map(); // question text -> { ord, seen }
  let seen = 0;
  for (const r of tallyRows || []) {
    const q = r.QUESTION;
    if (q == null || order.has(q)) continue;
    const ord = r.QUESTION_ORDER == null ? Number.MAX_SAFE_INTEGER : Number(r.QUESTION_ORDER);
    order.set(q, { ord, seen: seen++ });
  }
  return [...order.entries()]
    .sort((a, b) => a[1].ord - b[1].ord || a[1].seen - b[1].seen)
    .map(([q]) => q);
}

/**
 * The tally block for ONE poll: a header, the total, then each question (in
 * survey order) with its answers sorted by descending count.
 * @returns {{ block: Array[], totalResponses: number, orderedQuestions: string[] }}
 */
export function buildTallyBlock(pollId, tallyRows, now) {
  const rows = tallyRows || [];
  const totalResponses = rows.length ? rows[0].TOTAL_RESPONSES : 0;
  const orderedQuestions = questionOrderFromTally(rows);

  const byQuestion = {};
  for (const r of rows) (byQuestion[r.QUESTION] ??= []).push(r);

  const block = [];
  block.push([pollId]);
  block.push(["Total Responses:", totalResponses, `Last Updated: ${now} ET`]);

  for (const question of orderedQuestions) {
    const answers = (byQuestion[question] || [])
      .slice()
      .sort((a, b) => b.RESPONSE_COUNT - a.RESPONSE_COUNT);
    block.push([]); // gap before each question (and after the header line)
    block.push([`Q: "${question}"`]);
    block.push(["Answer", "Count", "%"]);
    for (const a of answers) {
      const pct =
        totalResponses > 0
          ? ((a.RESPONSE_COUNT / totalResponses) * 100).toFixed(1) + "%"
          : "0%";
      block.push([a.ANSWER, a.RESPONSE_COUNT, pct]);
    }
  }

  return { block, totalResponses, orderedQuestions };
}

/**
 * The per-response grid for ONE poll. Columns LEAD WITH the answers (in the
 * given survey order), THEN the demographic contract. Identity meta first.
 * Questions not present in `orderedQuestions` are appended (sorted) so nothing
 * is dropped.
 * @returns {Array[]} [header, ...dataRows]
 */
export function buildResponseGrid(responseRows, orderedQuestions = []) {
  const list = responseRows || [];

  const parsed = list.map((r) => parseAnswers(r.ANSWERS));

  const seen = new Set(orderedQuestions);
  const extras = new Set();
  for (const ans of parsed) {
    for (const q of Object.keys(ans)) if (!seen.has(q)) extras.add(q);
  }
  const questions = [
    ...orderedQuestions,
    ...[...extras].sort((a, b) => a.localeCompare(b)),
  ];

  const header = [
    ...META_COLUMNS.map(([label]) => label),
    ...questions,
    ...DEMOGRAPHIC_COLUMNS.map(([label]) => label),
  ];

  const dataRows = list.map((r, i) => {
    const ans = parsed[i];
    return [
      ...META_COLUMNS.map(([, key]) => fmtCell(r[key])),
      ...questions.map((q) => fmtAnswer(ans[q])),
      ...DEMOGRAPHIC_COLUMNS.map(([, key]) => fmtCell(r[key])),
    ];
  });

  return [header, ...dataRows];
}

/**
 * The full single-tab grid for ONE poll: tally block, a divider, then the
 * per-response grid. Both share one survey-order question list.
 */
export function buildSurveyGrid(pollId, tallyRows, responseRows, now) {
  const { block, orderedQuestions } = buildTallyBlock(pollId, tallyRows, now);
  const responseGrid = buildResponseGrid(responseRows, orderedQuestions);

  return [...block, [], [], [SECTION_DIVIDER], [], ...responseGrid];
}

/**
 * Group tally + response rows by POLL_ID into one stacked grid per poll.
 * The worker runs one poll per call, but grouping keeps this pure and testable.
 * @returns {Record<string, Array[]>} pollId -> grid
 */
export function buildSurveyGrids(tallyRows, responseRows, now) {
  const tallyByPoll = {};
  for (const r of tallyRows || []) (tallyByPoll[r.POLL_ID] ??= []).push(r);
  const respByPoll = {};
  for (const r of responseRows || []) (respByPoll[r.POLL_ID] ??= []).push(r);

  const pollIds = new Set([
    ...Object.keys(tallyByPoll),
    ...Object.keys(respByPoll),
  ]);

  const grids = {};
  for (const pollId of pollIds) {
    grids[pollId] = buildSurveyGrid(
      pollId,
      tallyByPoll[pollId] || [],
      respByPoll[pollId] || [],
      now
    );
  }
  return grids;
}
