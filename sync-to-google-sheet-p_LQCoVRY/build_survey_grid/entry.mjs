import { buildSurveyGrids } from "./transform.mjs";

// Thin Pipedream step. Must be `.mjs` (it uses `import`; Pipedream parses `.js`
// as CommonJS) and may only `export default`. The pure, unit-tested transform
// lives in the sibling ./transform.mjs (bundled into this step at deploy).
//
// Combines the tally rows + per-response demographics rows into ONE stacked
// grid per poll (tally above, per-response below) — the single-tab layout.
export default defineComponent({
  name: "Build Survey Grid",
  description:
    "Combines tally + per-response demographics into one stacked 2D grid per poll (tally above a divider, per-response grid below) for a single Google Sheets tab",
  props: {
    tally_rows: {
      type: "any",
      label: "Tally Rows",
      description: "Row results from the scoped tally query (carries QUESTION_ORDER)",
    },
    response_rows: {
      type: "any",
      label: "Response Demographics Rows",
      description: "Row results from the scoped V_SURVEY_RESPONSE_DEMOGRAPHICS query",
    },
  },
  async run({ $ }) {
    const tallyRows = this.tally_rows || [];
    const responseRows = this.response_rows || [];

    if (tallyRows.length === 0 && responseRows.length === 0) {
      $.export("$summary", "No survey responses found");
      return { grids: {} };
    }

    // Single ET timestamp for the "Last Updated" line (kept out of the pure transform).
    const now = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());

    const grids = buildSurveyGrids(tallyRows, responseRows, now);

    $.export(
      "$summary",
      `Built survey grid(s) for ${Object.keys(grids).length} poll(s)`
    );
    return { grids };
  },
});
