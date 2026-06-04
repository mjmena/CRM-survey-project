-- Issue #7, Module 3 — per-response survey + demographics export view.
-- Run: snowsql -f migration/survey_response_demographics_ddl.sql
-- Depends on: DIM_RESPONDENT_IDENTITY (Module 1), DIM_RESPONDENT_DEMOGRAPHICS
-- (Module 2's materialized serving table — joined here instead of the live AA view
-- so each Google Sheets sync is a cheap ~1.4k-row join, not a 497M-row AA scan).
--
-- Grain: EXACTLY one row per Poll response (INGESTION_ID). Identity and demographics
-- are LEFT-joined, so responses with no resolvable HEM still appear with blank
-- demographic columns (stories 9/22) and the tab reconciles with the tally grids.
--
-- Answers shape: a single SQL view cannot have a per-Poll-variable set of question
-- columns, so answers are carried as an ANSWERS object (question text -> answer,
-- multi-select comma-joined, catch-alls dropped per the rollup rules — story 21).
-- The per-Poll WIDE pivot (one column per question) is done by the pure, unit-tested
-- row-transform in the Sync to Google Sheet workflow (Module 4) — the PRD's prime
-- test target — which is also where per-survey tabs make the column set stable.

USE SCHEMA MCC_RAW.MARKETING_DEV;

CREATE OR REPLACE VIEW V_SURVEY_RESPONSE_DEMOGRAPHICS AS
WITH base AS (
    SELECT
        INGESTION_ID,
        POLL_ID,
        SUBMITTED_AT,
        NULLIF(RAW_DATA:market_name::STRING, '') AS MARKET_NAME   -- captured at submit time (story 4); blank -> NULL
    FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES
),
raw_answers AS (
    -- NB: do NOT alias STG_SURVEY_RESPONSES — its virtual columns (POLL_ID,
    -- SUBMITTED_AT) are defined against the literal table name STG_SURVEY_RESPONSES.RAW_DATA,
    -- so an alias puts that identifier out of scope.
    SELECT
        INGESTION_ID,
        POLL_ID,
        a.value:question::STRING AS QUESTION_KEY,
        a.value:answer           AS ANSWER_VARIANT,
        TYPEOF(a.value:answer)   AS ANSWER_TYPEOF
    FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES,
         LATERAL FLATTEN(input => RAW_DATA:answers) a
),
-- Resolve each answer element to a display label, dropping catch-alls.
answer_labels AS (
    -- single-select (and free-text, which simply won't match a catalog option)
    SELECT ra.INGESTION_ID, ra.POLL_ID, ra.QUESTION_KEY,
           COALESCE(o.OPTION_LABEL, ra.ANSWER_VARIANT::STRING) AS LABEL
    FROM raw_answers ra
    LEFT JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o
        ON  o.POLL_ID       = ra.POLL_ID
        AND o.QUESTION_KEY  = ra.QUESTION_KEY
        AND o.OPTION_VALUE  = ra.ANSWER_VARIANT::STRING
        AND o.OPTION_SOURCE = 'catalog'
    WHERE ra.ANSWER_TYPEOF = 'VARCHAR'
      AND COALESCE(o.IS_CATCH_ALL, FALSE) = FALSE
    UNION ALL
    -- multi-select: explode inner array
    SELECT exploded.INGESTION_ID, exploded.POLL_ID, exploded.QUESTION_KEY,
           COALESCE(o.OPTION_LABEL, exploded.ELEM) AS LABEL
    FROM (
        SELECT ra.INGESTION_ID, ra.POLL_ID, ra.QUESTION_KEY, ia.value::STRING AS ELEM
        FROM raw_answers ra,
             LATERAL FLATTEN(input => ra.ANSWER_VARIANT) ia
        WHERE ra.ANSWER_TYPEOF = 'ARRAY'
    ) exploded
    LEFT JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o
        ON  o.POLL_ID       = exploded.POLL_ID
        AND o.QUESTION_KEY  = exploded.QUESTION_KEY
        AND o.OPTION_VALUE  = exploded.ELEM
        AND o.OPTION_SOURCE = 'catalog'
    WHERE COALESCE(o.IS_CATCH_ALL, FALSE) = FALSE
),
-- Attach human-readable question text; drop empties.
answer_with_q AS (
    SELECT al.INGESTION_ID,
           COALESCE(q.QUESTION_TEXT, al.QUESTION_KEY) AS QUESTION_TEXT,
           al.LABEL
    FROM answer_labels al
    LEFT JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_QUESTIONS q
        ON q.POLL_ID = al.POLL_ID AND q.QUESTION_KEY = al.QUESTION_KEY
    WHERE al.LABEL IS NOT NULL AND TRIM(al.LABEL) <> ''
),
-- Comma-join multi-select within (response, question); dedupe before OBJECT_AGG.
q_joined AS (
    SELECT INGESTION_ID, QUESTION_TEXT,
           LISTAGG(DISTINCT LABEL, ', ') WITHIN GROUP (ORDER BY LABEL) AS ANSWER_TEXT
    FROM answer_with_q
    GROUP BY INGESTION_ID, QUESTION_TEXT
),
answers_obj AS (
    SELECT INGESTION_ID,
           OBJECT_AGG(QUESTION_TEXT, ANSWER_TEXT::VARIANT) AS ANSWERS
    FROM q_joined
    GROUP BY INGESTION_ID
)
SELECT
    b.INGESTION_ID                        AS INGESTION_ID,
    b.POLL_ID                             AS POLL_ID,
    b.SUBMITTED_AT                        AS SUBMITTED_AT,
    b.MARKET_NAME                         AS MARKET_NAME,
    i.HEM_SOURCE                          AS IDENTITY_SOURCE,   -- 'payload' | 'events' | NULL (story 10)
    dem.AGE_BAND                          AS AGE_BAND,
    dem.GENERATION                        AS GENERATION,
    dem.INCOME_HH                         AS INCOME_HH,
    dem.NET_WORTH_HH                      AS NET_WORTH_HH,
    dem.EDUCATION                         AS EDUCATION,
    dem.OCCUPATION_CATEGORY               AS OCCUPATION_CATEGORY,
    dem.MARITAL_STATUS                    AS MARITAL_STATUS,
    dem.HOME_OWNER                        AS HOME_OWNER,
    dem.ETHNIC_GROUP                      AS ETHNIC_GROUP,
    dem.HAS_CHILDREN_HH                   AS HAS_CHILDREN_HH,
    dem.GENDER                            AS GENDER,
    dem.STATE                             AS STATE,
    dem.DMA                               AS DMA,
    dem.AFFINITY_INVESTOR                 AS AFFINITY_INVESTOR,
    dem.AFFINITY_HOMEOWNER                AS AFFINITY_HOMEOWNER,
    COALESCE(ao.ANSWERS, OBJECT_CONSTRUCT()) AS ANSWERS
FROM base b
LEFT JOIN MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_IDENTITY i ON i.INGESTION_ID = b.INGESTION_ID
LEFT JOIN MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_DEMOGRAPHICS dem ON dem.HEM = i.HEM  -- materialized (not the live AA view) so each Sheets sync is cheap
LEFT JOIN answers_obj ao ON ao.INGESTION_ID = b.INGESTION_ID;

-- Grain + coverage smoke test (per SPICE):
SELECT
    COUNT(*)                                  AS RESPONSE_ROWS,
    COUNT(DISTINCT INGESTION_ID)              AS DISTINCT_RESPONSES,   -- must equal RESPONSE_ROWS
    COUNT(AGE_BAND)                           AS WITH_AGE,
    COUNT(MARKET_NAME)                        AS WITH_MARKET
FROM V_SURVEY_RESPONSE_DEMOGRAPHICS
WHERE POLL_ID = 'sf-generation-life-spice-poll';
