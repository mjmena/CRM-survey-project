const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// Snowflake TIMESTAMP_NTZ comes back as an ISO-ish string with no TZ designator.
// Source RAW_DATA stores submitted_at as UTC (e.g. "2026-05-07T18:54:07.170Z"),
// so we treat NTZ values as UTC clock-time and render in ET.
function formatSubmitted(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  let s = String(raw).replace(/(\.\d{3})\d+/, "$1");
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(raw);
  return ET_FMT.format(d);
}

export default defineComponent({
  name: "Build Tally Grids",
  description: "Transforms Snowflake tally + response rows into per-survey 2D grids for Google Sheets",
  props: {
    tally_rows: {
      type: "any",
      label: "Tally Rows",
      description: "Row results from the Snowflake tally query",
    },
    response_rows: {
      type: "any",
      label: "Response Rows",
      description: "Per-response rows from the Snowflake responses query",
    },
  },
  async run({ $ }) {
    const tallyRows = this.tally_rows || [];
    const responseRows = this.response_rows || [];

    if (tallyRows.length === 0) {
      $.export("$summary", "No survey responses found");
      return { grids: {} };
    }

    const surveys = {};
    for (const row of tallyRows) {
      const pollId = row.POLL_ID;
      if (!surveys[pollId]) {
        surveys[pollId] = { totalResponses: row.TOTAL_RESPONSES, rows: [] };
      }
      surveys[pollId].rows.push(row);
    }

    const responsesByPoll = {};
    for (const r of responseRows) {
      const pid = r.POLL_ID;
      const id = r.INGESTION_ID;
      const byPoll = (responsesByPoll[pid] ??= {});
      const resp = (byPoll[id] ??= { submittedAt: r.SUBMITTED_AT, byQuestion: {} });
      (resp.byQuestion[r.QUESTION] ??= []).push(r.ANSWER);
    }

    const now = ET_FMT.format(new Date());
    const grids = {};

    for (const [pollId, survey] of Object.entries(surveys)) {
      const grid = [];
      grid.push([pollId]);
      grid.push(["Total Responses:", survey.totalResponses, `Last Updated: ${now} ET`]);
      grid.push([]);

      const byQuestion = {};
      for (const r of survey.rows) {
        (byQuestion[r.QUESTION] ??= []).push(r);
      }

      const sortedQuestions = Object.keys(byQuestion).sort((a, b) => a.localeCompare(b));

      let first = true;
      for (const question of sortedQuestions) {
        if (!first) grid.push([]);
        grid.push([`Q: "${question}"`]);
        grid.push(["Answer", "Count", "%"]);
        for (const a of byQuestion[question]) {
          const pct = survey.totalResponses > 0
            ? ((a.RESPONSE_COUNT / survey.totalResponses) * 100).toFixed(1) + "%"
            : "0%";
          grid.push([a.ANSWER, a.RESPONSE_COUNT, pct]);
        }
        first = false;
      }

      const responses = Object.values(responsesByPoll[pollId] || {});
      if (responses.length > 0) {
        responses.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
        grid.push([]);
        grid.push([`All Responses (${responses.length})`]);
        grid.push(["Submitted At (ET)", ...sortedQuestions]);
        for (const resp of responses) {
          const row = [formatSubmitted(resp.submittedAt)];
          for (const q of sortedQuestions) {
            row.push((resp.byQuestion[q] || []).join(", "));
          }
          grid.push(row);
        }
      }

      grids[pollId] = grid;
    }

    $.export("$summary", `Built tally grids for ${Object.keys(grids).length} survey(s)`);
    return { grids };
  },
});
