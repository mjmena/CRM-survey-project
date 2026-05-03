export default defineComponent({
  name: "Format MCP Response",
  description:
    "Shapes Snowflake rows into an MCP JSON-RPC tools/call response and sends it via $.respond().",
  props: {
    dispatch: {
      type: "any",
      label: "Dispatch",
      description: "Output from parse_and_dispatch: { tool, args, requestId }",
    },
    rows: {
      type: "any",
      label: "Rows",
      description: "Row array returned by the Snowflake registry action",
    },
  },

  async run({ $ }) {
    const { tool, args, requestId } = this.dispatch;
    const rows = this.rows ?? [];

    let text;

    if (tool === "get_survey_catalog") {
      const polls = {};
      for (const row of rows) {
        const pid = row.POLL_ID;
        if (!polls[pid]) polls[pid] = [];
        polls[pid].push({
          question_key: row.QUESTION_KEY,
          question_text: row.QUESTION_TEXT,
          option_value: row.OPTION_VALUE,
          option_label: row.OPTION_LABEL,
          is_catch_all: row.IS_CATCH_ALL,
        });
      }
      text = JSON.stringify({ total_rows: rows.length, polls }, null, 2);
    }

    else if (tool === "get_taxonomy") {
      text = JSON.stringify({ total_rows: rows.length, rows }, null, 2);
    }

    else if (tool === "get_survey_responses") {
      const totalResponses = rows.length > 0 ? rows[0].TOTAL_RESPONSES : 0;
      const questions = {};
      for (const row of rows) {
        const q = row.QUESTION;
        if (!questions[q]) questions[q] = [];
        questions[q].push({
          answer: row.ANSWER,
          count: row.RESPONSE_COUNT,
          pct: row.PCT,
        });
      }
      text = JSON.stringify(
        { poll_id: args.poll_id, total_responses: totalResponses, questions },
        null,
        2
      );
    }

    else {
      text = JSON.stringify({ rows });
    }

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result: {
          content: [{ type: "text", text }],
          isError: false,
        },
      }),
    });

    $.export("$summary", `${tool}: ${rows.length} rows`);
  },
});
