import { buildResponseGrids } from "./transform.js";

// Thin Pipedream step: a code step may only `export default` (named exports break
// the deploy), so the pure, unit-tested transform lives in ./transform.js.
export default defineComponent({
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
