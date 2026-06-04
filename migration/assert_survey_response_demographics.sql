-- Issue #7, Module 3 — assertions for V_SURVEY_RESPONSE_DEMOGRAPHICS.
-- Run: snowsql -f migration/assert_survey_response_demographics.sql
-- Each row returns PASS/FAIL; any FAIL means the per-row export regressed.
-- Anchored on SPICE (sf-generation-life-spice-poll).

USE SCHEMA MCC_RAW.MARKETING_DEV;

SET poll = 'sf-generation-life-spice-poll';

-- B1. Grain: exactly one export row per Poll response (matches STG row count),
--     so the tab reconciles with the tally grids (story 9) and never fans out.
SELECT 'B1 one row per response' AS ASSERTION,
       IFF(v.row_cnt = s.responses AND v.row_cnt = v.distinct_rows, 'PASS', 'FAIL') AS RESULT,
       v.row_cnt AS EXPORT_ROWS, v.distinct_rows AS DISTINCT_RESPONSES, s.responses AS STG_RESPONSES
FROM (
    SELECT COUNT(*) AS row_cnt, COUNT(DISTINCT INGESTION_ID) AS distinct_rows
    FROM V_SURVEY_RESPONSE_DEMOGRAPHICS WHERE POLL_ID = $poll
) v,
(
    SELECT COUNT(*) AS responses
    FROM STG_SURVEY_RESPONSES WHERE POLL_ID = $poll
) s;

-- B2. Demographic coverage: a meaningful share of responses carry an age band.
--     (SPICE ~68%; threshold guards against a join/grain regression dropping it.)
SELECT 'B2 demographic coverage >= 50%' AS ASSERTION,
       IFF(COUNT(AGE_BAND) / NULLIF(COUNT(*), 0) >= 0.50, 'PASS', 'FAIL') AS RESULT,
       COUNT(*) AS RESPONSES, COUNT(AGE_BAND) AS WITH_AGE,
       ROUND(COUNT(AGE_BAND) / NULLIF(COUNT(*), 0), 3) AS COVERAGE
FROM V_SURVEY_RESPONSE_DEMOGRAPHICS WHERE POLL_ID = $poll;

-- B3. Market captured at submit time passes through to the export (story 4).
SELECT 'B3 market passthrough' AS ASSERTION,
       IFF(COUNT(MARKET_NAME) > 0, 'PASS', 'FAIL') AS RESULT,
       COUNT(MARKET_NAME) AS WITH_MARKET
FROM V_SURVEY_RESPONSE_DEMOGRAPHICS WHERE POLL_ID = $poll;

-- B4. Unresolved responses still appear with blank demographics (story 9):
--     there should be at least one row with a null AGE_BAND (not silently dropped).
SELECT 'B4 unresolved rows present' AS ASSERTION,
       IFF(COUNT_IF(AGE_BAND IS NULL) > 0, 'PASS', 'FAIL') AS RESULT,
       COUNT_IF(AGE_BAND IS NULL) AS BLANK_DEMO_ROWS
FROM V_SURVEY_RESPONSE_DEMOGRAPHICS WHERE POLL_ID = $poll;

-- B5. No direct-PII columns leaked into the per-row export either.
SELECT 'B5 no direct-PII columns' AS ASSERTION,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS RESULT,
       LISTAGG(COLUMN_NAME, ', ') AS OFFENDING
FROM MCC_RAW.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'MARKETING_DEV'
  AND TABLE_NAME = 'V_SURVEY_RESPONSE_DEMOGRAPHICS'
  AND (
      COLUMN_NAME ILIKE '%FIRST_NAME%'
   OR COLUMN_NAME ILIKE '%LAST_NAME%'
   OR COLUMN_NAME ILIKE '%ADDRESS%'
   OR COLUMN_NAME ILIKE '%ZIP%'
   OR COLUMN_NAME ILIKE '%LAT%'
   OR COLUMN_NAME ILIKE '%LON%'
   OR COLUMN_NAME ILIKE '%EMAIL%'
   OR COLUMN_NAME ILIKE '%CENSUS%'
  );
