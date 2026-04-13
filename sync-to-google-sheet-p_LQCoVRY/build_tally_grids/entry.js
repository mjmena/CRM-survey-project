export default defineComponent({
  name: "Build Tally Grids",
  description: "Transforms Snowflake tally rows into per-survey 2D grids for Google Sheets",
  props: {
    tally_rows: {
      type: "any",
      label: "Tally Rows",
      description: "Row results from the Snowflake tally query",
    },
  },
  async run({ $ }) {
    const rows = this.tally_rows || [];

    if (rows.length === 0) {
      $.export("$summary", "No survey responses found");
      return { grids: {} };
    }

    // Group rows by POLL_ID
    const surveys = {};
    for (const row of rows) {
      const pollId = row.POLL_ID;
      if (!surveys[pollId]) {
        surveys[pollId] = { totalResponses: row.TOTAL_RESPONSES, rows: [] };
      }
      surveys[pollId].rows.push(row);
    }

    // Build a 2D grid for each survey
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

    const grids = {};

    for (const [pollId, survey] of Object.entries(surveys)) {
      const grid = [];
      grid.push([pollId]);
      grid.push([`Total Responses: ${survey.totalResponses}`, `Last Updated: ${now} ET`]);
      grid.push([]);

      // Group by question
      const byQuestion = {};
      for (const r of survey.rows) {
        (byQuestion[r.QUESTION] ??= []).push(r);
      }

      let first = true;
      for (const [question, answers] of Object.entries(byQuestion).sort(([a], [b]) => a.localeCompare(b))) {
        if (!first) grid.push([]);
        grid.push([`Q: "${question}"`]);
        grid.push(["Answer", "Count", "%"]);
        for (const a of answers) {
          const pct = survey.totalResponses > 0
            ? ((a.RESPONSE_COUNT / survey.totalResponses) * 100).toFixed(1) + "%"
            : "0%";
          grid.push([a.ANSWER, a.RESPONSE_COUNT, pct]);
        }
        first = false;
      }

      grids[pollId] = grid;
    }

    $.export("$summary", `Built tally grids for ${Object.keys(grids).length} survey(s)`);
    return { grids };
  },
});
