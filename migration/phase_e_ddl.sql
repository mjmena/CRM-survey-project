-- Phase E: Rewrite V_AMPLITUDE_SURVEY_SYNC
-- Run: snowsql -f migration/phase_e_ddl.sql
-- Fixes: view was joining on (POLL_ID, QUESTION_KEY, OPTION_VALUE) which no longer
-- exist in DIM_SURVEY_TAXONOMY after Phase C renamed it to use OPTION_ID.
-- Also fixes: multi-select ARRAY answers silently dropped; text responses supported.

USE SCHEMA MCC_RAW.MARKETING_DEV;

CREATE OR REPLACE VIEW V_AMPLITUDE_SURVEY_SYNC AS
WITH

-- Explode outer answers array; capture INDEX for page-order sequence evaluation.
raw_answers AS (
    SELECT
        INGESTION_ID,
        RAW_DATA:device_id::STRING  AS DEVICE_ID,
        POLL_ID,
        a.INDEX                     AS ANSWER_POS,
        a.value:question::STRING    AS QUESTION_KEY,
        a.value:answer              AS ANSWER_VARIANT,
        TYPEOF(a.value:answer)      AS ANSWER_TYPEOF
    FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES,
         LATERAL FLATTEN(input => RAW_DATA:answers) a
    WHERE RAW_DATA:device_id::STRING IS NOT NULL
),

-- Resolve each answer to (INGESTION_ID, DEVICE_ID, ANSWER_POS, OPTION_ID).
answer_options AS (
    -- Single-select catalog options
    SELECT ra.INGESTION_ID, ra.DEVICE_ID, ra.ANSWER_POS, o.OPTION_ID
    FROM raw_answers ra
    JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o
        ON  o.POLL_ID       = ra.POLL_ID
        AND o.QUESTION_KEY  = ra.QUESTION_KEY
        AND o.OPTION_VALUE  = ra.ANSWER_VARIANT::STRING
        AND o.OPTION_SOURCE = 'catalog'
    WHERE ra.ANSWER_TYPEOF = 'VARCHAR'
    UNION ALL
    -- Text responses: normalized OPTION_VALUE match
    SELECT ra.INGESTION_ID, ra.DEVICE_ID, ra.ANSWER_POS, o.OPTION_ID
    FROM raw_answers ra
    JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o
        ON  o.POLL_ID       = ra.POLL_ID
        AND o.QUESTION_KEY  = ra.QUESTION_KEY
        AND o.OPTION_VALUE  = LOWER(TRIM(ra.ANSWER_VARIANT::STRING))
        AND o.OPTION_SOURCE = 'response'
    WHERE ra.ANSWER_TYPEOF = 'VARCHAR'
      AND TRIM(ra.ANSWER_VARIANT::STRING) <> ''
    UNION ALL
    -- Multi-select: explode inner array (fixes silent-drop bug for ARRAY answers)
    -- Subquery avoids comma-join + explicit JOIN ambiguity in Snowflake
    SELECT exploded.INGESTION_ID, exploded.DEVICE_ID, exploded.ANSWER_POS, o.OPTION_ID
    FROM (
        SELECT ra.INGESTION_ID, ra.DEVICE_ID, ra.ANSWER_POS,
               ra.POLL_ID, ra.QUESTION_KEY,
               ia.value::STRING AS ELEM_VALUE
        FROM raw_answers ra,
             LATERAL FLATTEN(input => ra.ANSWER_VARIANT) ia
        WHERE ra.ANSWER_TYPEOF = 'ARRAY'
    ) exploded
    JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o
        ON  o.POLL_ID       = exploded.POLL_ID
        AND o.QUESTION_KEY  = exploded.QUESTION_KEY
        AND o.OPTION_VALUE  = exploded.ELEM_VALUE
        AND o.OPTION_SOURCE = 'catalog'
),

-- Unconditional taxonomy: applies whenever the option is answered
unconditional_taxonomy AS (
    SELECT ao.INGESTION_ID, ao.DEVICE_ID,
           t.BUCKET, t.TAXONOMY_PATH, t.DEMOGRAPHIC_KEY, t.DEMOGRAPHIC_VALUE
    FROM answer_options ao
    JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t ON t.OPTION_ID = ao.OPTION_ID
    JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS  o ON o.OPTION_ID = ao.OPTION_ID
    WHERE (t.CONDITION_SEQUENCE IS NULL OR ARRAY_SIZE(t.CONDITION_SEQUENCE) = 0)
      AND o.IS_CATCH_ALL = FALSE
),

-- Expand CONDITION_SEQUENCE into one row per required OPTION_ID (non-correlated FLATTEN)
taxonomy_condition_elements AS (
    SELECT
        t.OPTION_ID              AS TAX_OPTION_ID,
        t.BUCKET,
        t.TAXONOMY_PATH,
        t.DEMOGRAPHIC_KEY,
        t.DEMOGRAPHIC_VALUE,
        c.INDEX                  AS SEQ_INDEX,
        c.VALUE::NUMBER          AS REQUIRED_OPTION_ID,
        ARRAY_SIZE(t.CONDITION_SEQUENCE) AS TOTAL_REQUIRED
    FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t,
         LATERAL FLATTEN(input => t.CONDITION_SEQUENCE) c
    WHERE ARRAY_SIZE(t.CONDITION_SEQUENCE) > 0
),

-- For each submission x taxonomy rule, look up each required option's ANSWER_POS
condition_positions AS (
    SELECT
        ao.INGESTION_ID,
        ao.DEVICE_ID,
        tce.TAX_OPTION_ID,
        tce.BUCKET,
        tce.TAXONOMY_PATH,
        tce.DEMOGRAPHIC_KEY,
        tce.DEMOGRAPHIC_VALUE,
        tce.SEQ_INDEX,
        tce.REQUIRED_OPTION_ID,
        tce.TOTAL_REQUIRED,
        sub.ANSWER_POS
    FROM answer_options ao
    JOIN taxonomy_condition_elements tce ON tce.TAX_OPTION_ID = ao.OPTION_ID
    LEFT JOIN answer_options sub
        ON  sub.INGESTION_ID = ao.INGESTION_ID
        AND sub.OPTION_ID    = tce.REQUIRED_OPTION_ID
),

-- LEAD() gives each element its next element's page position for ordering check
condition_ordering AS (
    SELECT
        INGESTION_ID, DEVICE_ID, TAX_OPTION_ID, BUCKET, TAXONOMY_PATH,
        DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE, TOTAL_REQUIRED,
        CASE WHEN ANSWER_POS IS NULL THEN 1 ELSE 0 END AS IS_MISSING,
        ANSWER_POS AS THIS_POS,
        LEAD(ANSWER_POS) OVER (
            PARTITION BY INGESTION_ID, TAX_OPTION_ID
            ORDER BY SEQ_INDEX
        ) AS NEXT_POS
    FROM condition_positions
),

-- A rule is satisfied when all required options are present AND in ascending page order
conditional_satisfied AS (
    SELECT INGESTION_ID, DEVICE_ID, TAX_OPTION_ID, BUCKET, TAXONOMY_PATH,
           DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE
    FROM condition_ordering
    GROUP BY INGESTION_ID, DEVICE_ID, TAX_OPTION_ID, BUCKET, TAXONOMY_PATH,
             DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE
    HAVING SUM(IS_MISSING) = 0
       AND SUM(CASE WHEN NEXT_POS IS NOT NULL AND THIS_POS >= NEXT_POS THEN 1 ELSE 0 END) = 0
),

conditional_taxonomy AS (
    SELECT cs.INGESTION_ID, cs.DEVICE_ID,
           cs.BUCKET, cs.TAXONOMY_PATH, cs.DEMOGRAPHIC_KEY, cs.DEMOGRAPHIC_VALUE
    FROM conditional_satisfied cs
    JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o ON o.OPTION_ID = cs.TAX_OPTION_ID
    WHERE o.IS_CATCH_ALL = FALSE
),

user_taxonomies AS (
    SELECT * FROM unconditional_taxonomy
    UNION ALL
    SELECT * FROM conditional_taxonomy
)

SELECT DEVICE_ID, 'consumption_insights' AS USER_PROPERTY,
       ARRAY_AGG(DISTINCT TAXONOMY_PATH)::STRING AS USER_PROPERTY_VALUE
FROM user_taxonomies
WHERE BUCKET = 'consumption' AND TAXONOMY_PATH IS NOT NULL
GROUP BY DEVICE_ID

UNION ALL

SELECT DEVICE_ID, 'preference_insights' AS USER_PROPERTY,
       ARRAY_AGG(DISTINCT TAXONOMY_PATH)::STRING AS USER_PROPERTY_VALUE
FROM user_taxonomies
WHERE BUCKET = 'preference' AND TAXONOMY_PATH IS NOT NULL
GROUP BY DEVICE_ID

UNION ALL

SELECT DEVICE_ID, DEMOGRAPHIC_KEY AS USER_PROPERTY, DEMOGRAPHIC_VALUE AS USER_PROPERTY_VALUE
FROM user_taxonomies
WHERE BUCKET = 'demographic' AND DEMOGRAPHIC_KEY IS NOT NULL
GROUP BY DEVICE_ID, DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE;

-- Smoke test: row counts and shape
SELECT USER_PROPERTY, COUNT(*) AS ROW_CNT, COUNT(DISTINCT DEVICE_ID) AS DEVICES
FROM V_AMPLITUDE_SURVEY_SYNC
GROUP BY USER_PROPERTY
ORDER BY USER_PROPERTY;
