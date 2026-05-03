const SCHEMA = "MCC_RAW.MARKETING_DEV";

export default defineComponent({
  name: "Build SQL",
  description:
    "Translates the dispatched Snowflake tool + args into a parameterized SQL query and params array.",
  props: {
    dispatch: {
      type: "any",
      label: "Dispatch",
      description: "Output from parse_and_dispatch: { tool, args, requestId }",
    },
  },

  async run({ $ }) {
    const { tool, args } = this.dispatch;

    if (tool === "get_survey_catalog") {
      if (args.poll_id) {
        return {
          sql: `
SELECT POLL_ID, QUESTION_KEY, QUESTION_TEXT, OPTION_VALUE, OPTION_LABEL, IS_CATCH_ALL, UPDATED_AT
FROM ${SCHEMA}.DIM_SURVEY_CATALOG
WHERE POLL_ID = ?
ORDER BY POLL_ID, QUESTION_KEY, OPTION_VALUE
          `.trim(),
          params: [args.poll_id],
        };
      }
      return {
        sql: `
SELECT POLL_ID, QUESTION_KEY, QUESTION_TEXT, OPTION_VALUE, OPTION_LABEL, IS_CATCH_ALL, UPDATED_AT
FROM ${SCHEMA}.DIM_SURVEY_CATALOG
ORDER BY POLL_ID, QUESTION_KEY, OPTION_VALUE
        `.trim(),
        params: [],
      };
    }

    if (tool === "get_taxonomy") {
      const clauses = [];
      const params = [];

      if (args.poll_id) {
        clauses.push("POLL_ID = ?");
        params.push(args.poll_id);
      }
      if (args.bucket) {
        clauses.push("LOWER(BUCKET) = LOWER(?)");
        params.push(args.bucket);
      }
      if (typeof args.min_confidence === "number") {
        clauses.push("CONFIDENCE >= ?");
        params.push(args.min_confidence);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return {
        sql: `
SELECT POLL_ID, QUESTION_KEY, OPTION_VALUE, BUCKET,
       TAXONOMY_PATH, TAXONOMY_DEPTH, TAXONOMY_LEVELS,
       DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE, DEMOGRAPHIC_TYPE,
       CONFIDENCE, UPDATED_AT
FROM ${SCHEMA}.DIM_SURVEY_TAXONOMY
${where}
ORDER BY POLL_ID, BUCKET, QUESTION_KEY, OPTION_VALUE
        `.trim(),
        params,
      };
    }

    if (tool === "get_survey_responses") {
      // poll_id used twice: once in tally CTE, once in totals CTE
      return {
        sql: `
WITH tally AS (
    SELECT
        RAW_DATA:poll_id::STRING      AS POLL_ID,
        a.value:question::STRING      AS QUESTION_KEY,
        a.value:answer::STRING        AS ANSWER_VALUE,
        COUNT(*)                      AS RESPONSE_COUNT
    FROM ${SCHEMA}.STG_SURVEY_RESPONSES,
         LATERAL FLATTEN(input => RAW_DATA:answers) a
    WHERE RAW_DATA:poll_id::STRING = ?
    GROUP BY 1, 2, 3
),
totals AS (
    SELECT
        RAW_DATA:poll_id::STRING AS POLL_ID,
        COUNT(*)                 AS TOTAL_RESPONSES
    FROM ${SCHEMA}.STG_SURVEY_RESPONSES
    WHERE RAW_DATA:poll_id::STRING = ?
    GROUP BY 1
)
SELECT
    t.TOTAL_RESPONSES,
    COALESCE(q.QUESTION_TEXT, tally.QUESTION_KEY) AS QUESTION,
    COALESCE(c.OPTION_LABEL, tally.ANSWER_VALUE)  AS ANSWER,
    tally.RESPONSE_COUNT,
    ROUND(tally.RESPONSE_COUNT / NULLIF(t.TOTAL_RESPONSES, 0) * 100, 1) AS PCT
FROM tally
JOIN totals t ON tally.POLL_ID = t.POLL_ID
LEFT JOIN (
    SELECT DISTINCT POLL_ID, QUESTION_KEY, QUESTION_TEXT
    FROM ${SCHEMA}.DIM_SURVEY_CATALOG
) q ON tally.POLL_ID = q.POLL_ID AND tally.QUESTION_KEY = q.QUESTION_KEY
LEFT JOIN ${SCHEMA}.DIM_SURVEY_CATALOG c
    ON tally.POLL_ID = c.POLL_ID
    AND tally.QUESTION_KEY = c.QUESTION_KEY
    AND tally.ANSWER_VALUE = c.OPTION_VALUE
ORDER BY tally.QUESTION_KEY, tally.RESPONSE_COUNT DESC
        `.trim(),
        params: [args.poll_id, args.poll_id],
      };
    }

    throw new Error(`build_sql: unknown tool "${tool}"`);
  },
});
