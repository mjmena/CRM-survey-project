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
      const clauses = ["o.OPTION_SOURCE = 'catalog'"];
      const params = [];
      if (args.poll_id) {
        clauses.push("q.POLL_ID = ?");
        params.push(args.poll_id);
      }
      const where = `WHERE ${clauses.join(" AND ")}`;
      return {
        sql: `
SELECT q.POLL_ID, q.QUESTION_KEY, q.QUESTION_TYPE, q.QUESTION_TEXT,
       o.OPTION_ID, o.OPTION_VALUE, o.OPTION_LABEL, o.OPTION_DESCRIPTION,
       o.IS_CATCH_ALL, o.SORT_ORDER
FROM ${SCHEMA}.DIM_SURVEY_QUESTIONS q
JOIN ${SCHEMA}.DIM_SURVEY_OPTIONS o
  ON o.POLL_ID = q.POLL_ID AND o.QUESTION_KEY = q.QUESTION_KEY
${where}
ORDER BY q.POLL_ID, q.QUESTION_KEY, o.SORT_ORDER, o.OPTION_VALUE
        `.trim(),
        params,
      };
    }

    if (tool === "get_taxonomy") {
      const clauses = [];
      const params = [];

      if (args.poll_id) {
        clauses.push("o.POLL_ID = ?");
        params.push(args.poll_id);
      }
      if (args.bucket) {
        clauses.push("LOWER(t.BUCKET) = LOWER(?)");
        params.push(args.bucket);
      }
      if (typeof args.min_confidence === "number") {
        clauses.push("t.CONFIDENCE >= ?");
        params.push(args.min_confidence);
      }
      if (args.source === "catalog" || args.source === "response") {
        clauses.push("o.OPTION_SOURCE = ?");
        params.push(args.source);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return {
        sql: `
SELECT o.POLL_ID, o.QUESTION_KEY, o.OPTION_VALUE, o.OPTION_SOURCE,
       t.BUCKET, t.TAXONOMY_PATH, t.TAXONOMY_DEPTH, t.TAXONOMY_LEVELS,
       t.DEMOGRAPHIC_KEY, t.DEMOGRAPHIC_VALUE, t.DEMOGRAPHIC_TYPE,
       t.CONFIDENCE, t.IS_APPROVED, t.UPDATED_AT
FROM ${SCHEMA}.DIM_SURVEY_TAXONOMY t
JOIN ${SCHEMA}.DIM_SURVEY_OPTIONS o ON o.OPTION_ID = t.OPTION_ID
${where}
ORDER BY o.POLL_ID, t.BUCKET, o.QUESTION_KEY, o.OPTION_VALUE
        `.trim(),
        params,
      };
    }

    if (tool === "get_survey_responses") {
      return {
        sql: `
WITH raw AS (
    SELECT
        RAW_DATA:poll_id::STRING  AS POLL_ID,
        a.value:question::STRING  AS QUESTION_KEY,
        a.value:answer            AS ANSWER_VARIANT,
        TYPEOF(a.value:answer)    AS ANSWER_TYPEOF
    FROM ${SCHEMA}.STG_SURVEY_RESPONSES,
         LATERAL FLATTEN(input => RAW_DATA:answers) a
    WHERE RAW_DATA:poll_id::STRING = ?
),
tally AS (
    SELECT POLL_ID, QUESTION_KEY, ANSWER_VARIANT::STRING AS ANSWER_VALUE, COUNT(*) AS RESPONSE_COUNT
    FROM raw
    WHERE ANSWER_TYPEOF = 'VARCHAR'
    GROUP BY 1, 2, 3
    UNION ALL
    SELECT raw.POLL_ID, raw.QUESTION_KEY, ia.value::STRING AS ANSWER_VALUE, COUNT(*) AS RESPONSE_COUNT
    FROM raw,
         LATERAL FLATTEN(input => raw.ANSWER_VARIANT) ia
    WHERE raw.ANSWER_TYPEOF = 'ARRAY'
    GROUP BY 1, 2, 3
),
totals AS (
    SELECT RAW_DATA:poll_id::STRING AS POLL_ID, COUNT(*) AS TOTAL_RESPONSES
    FROM ${SCHEMA}.STG_SURVEY_RESPONSES
    WHERE RAW_DATA:poll_id::STRING = ?
    GROUP BY 1
)
SELECT
    t.TOTAL_RESPONSES,
    COALESCE(q.QUESTION_TEXT, tally.QUESTION_KEY) AS QUESTION,
    COALESCE(o.OPTION_LABEL, tally.ANSWER_VALUE)  AS ANSWER,
    tally.RESPONSE_COUNT,
    ROUND(tally.RESPONSE_COUNT / NULLIF(t.TOTAL_RESPONSES, 0) * 100, 1) AS PCT
FROM tally
JOIN totals t ON tally.POLL_ID = t.POLL_ID
LEFT JOIN ${SCHEMA}.DIM_SURVEY_QUESTIONS q
    ON q.POLL_ID = tally.POLL_ID AND q.QUESTION_KEY = tally.QUESTION_KEY
LEFT JOIN ${SCHEMA}.DIM_SURVEY_OPTIONS o
    ON o.POLL_ID = tally.POLL_ID AND o.QUESTION_KEY = tally.QUESTION_KEY
    AND o.OPTION_VALUE = tally.ANSWER_VALUE AND o.OPTION_SOURCE = 'catalog'
ORDER BY tally.QUESTION_KEY, tally.RESPONSE_COUNT DESC
        `.trim(),
        params: [args.poll_id, args.poll_id],
      };
    }

    if (tool === "get_text_answers") {
      const clauses = ["o.OPTION_SOURCE = 'response'"];
      const params = [];
      if (args.poll_id) {
        clauses.push("o.POLL_ID = ?");
        params.push(args.poll_id);
      }
      if (args.unclassified_only) {
        clauses.push(
          `NOT EXISTS (SELECT 1 FROM ${SCHEMA}.DIM_SURVEY_TAXONOMY t WHERE t.OPTION_ID = o.OPTION_ID)`
        );
      }
      const where = `WHERE ${clauses.join(" AND ")}`;
      return {
        sql: `
SELECT o.OPTION_ID, o.POLL_ID, o.QUESTION_KEY, o.OPTION_VALUE,
       q.QUESTION_TEXT, q.QUESTION_TYPE
FROM ${SCHEMA}.DIM_SURVEY_OPTIONS o
JOIN ${SCHEMA}.DIM_SURVEY_QUESTIONS q
  ON q.POLL_ID = o.POLL_ID AND q.QUESTION_KEY = o.QUESTION_KEY
${where}
ORDER BY o.POLL_ID, o.QUESTION_KEY, o.OPTION_VALUE
LIMIT 5000
        `.trim(),
        params,
      };
    }

    if (tool === "get_answer_patterns") {
      if (!args.poll_id) throw new Error("get_answer_patterns requires poll_id");
      return {
        sql: `
WITH answers AS (
    SELECT INGESTION_ID, POLL_ID,
           a.INDEX                    AS ANSWER_POS,
           a.value:question::STRING   AS QUESTION_KEY,
           a.value:answer::STRING     AS ANSWER_VALUE
    FROM ${SCHEMA}.STG_SURVEY_RESPONSES,
         LATERAL FLATTEN(input => RAW_DATA:answers) a
    WHERE POLL_ID = ?
      AND TYPEOF(a.value:answer) = 'VARCHAR'
)
SELECT
    a1.QUESTION_KEY   AS Q1_KEY,
    o1.OPTION_ID      AS Q1_OPTION_ID,
    a1.ANSWER_VALUE   AS Q1_OPTION,
    a2.QUESTION_KEY   AS Q2_KEY,
    o2.OPTION_ID      AS Q2_OPTION_ID,
    a2.ANSWER_VALUE   AS Q2_OPTION,
    COUNT(*)          AS CO_COUNT
FROM answers a1
JOIN answers a2
    ON  a2.INGESTION_ID  = a1.INGESTION_ID
    AND a2.ANSWER_POS    > a1.ANSWER_POS
    AND a2.QUESTION_KEY != a1.QUESTION_KEY
LEFT JOIN ${SCHEMA}.DIM_SURVEY_OPTIONS o1
    ON  o1.POLL_ID       = a1.POLL_ID
    AND o1.QUESTION_KEY  = a1.QUESTION_KEY
    AND o1.OPTION_VALUE  = a1.ANSWER_VALUE
    AND o1.OPTION_SOURCE = 'catalog'
LEFT JOIN ${SCHEMA}.DIM_SURVEY_OPTIONS o2
    ON  o2.POLL_ID       = a2.POLL_ID
    AND o2.QUESTION_KEY  = a2.QUESTION_KEY
    AND o2.OPTION_VALUE  = a2.ANSWER_VALUE
    AND o2.OPTION_SOURCE = 'catalog'
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY CO_COUNT DESC
LIMIT 50
        `.trim(),
        params: [args.poll_id],
      };
    }

    if (tool === "create_taxonomy_rule") {
      const {
        poll_id, question_key, option_value,
        bucket, taxonomy_path,
        demographic_key, demographic_value, demographic_type,
        confidence, condition_option_ids,
      } = args;

      if (!poll_id || !question_key || !option_value || !bucket || confidence == null) {
        throw new Error("create_taxonomy_rule requires: poll_id, question_key, option_value, bucket, confidence");
      }

      const levels = taxonomy_path ? taxonomy_path.split("|") : null;
      const taxonomy_depth = levels ? levels.length : null;
      const taxonomy_levels_json = levels ? JSON.stringify(levels) : "null";
      const condition_json =
        condition_option_ids && condition_option_ids.length > 0
          ? JSON.stringify(condition_option_ids)
          : "null";

      return {
        sql: `
INSERT INTO ${SCHEMA}.DIM_SURVEY_TAXONOMY (
    OPTION_ID, BUCKET, TAXONOMY_PATH, TAXONOMY_DEPTH, TAXONOMY_LEVELS,
    DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE, DEMOGRAPHIC_TYPE,
    CONFIDENCE, CONDITION_SEQUENCE, CLASSIFIED_BY
)
SELECT o.OPTION_ID, ?, ?, ?, PARSE_JSON(?), ?, ?, ?, ?, PARSE_JSON(?), 'claude'
FROM ${SCHEMA}.DIM_SURVEY_OPTIONS o
WHERE o.POLL_ID       = ?
  AND o.QUESTION_KEY  = ?
  AND o.OPTION_VALUE  = ?
  AND o.OPTION_SOURCE = 'catalog'
        `.trim(),
        params: [
          bucket,
          taxonomy_path ?? null,
          taxonomy_depth,
          taxonomy_levels_json,
          demographic_key ?? null,
          demographic_value ?? null,
          demographic_type ?? null,
          confidence,
          condition_json,
          poll_id,
          question_key,
          option_value,
        ],
      };
    }

    throw new Error(`build_sql: unknown tool "${tool}"`);
  },
});
