-- Issue #7, Module 2 — assertions for DIM_RESPONDENT_DEMOGRAPHICS.
-- Run: snowsql -f migration/assert_respondent_demographics.sql
-- Each row returns PASS/FAIL; any FAIL means the enrichment contract regressed.
-- Anchored on SPICE (sf-generation-life-spice-poll) — refresh its identity first.

USE SCHEMA MCC_RAW.MARKETING_DEV;

-- A1. One demographics row per HEM (the HEM->AA-person fan-out is fully collapsed).
SELECT 'A1 one row per HEM' AS ASSERTION,
       IFF(COUNT(*) = COUNT(DISTINCT HEM), 'PASS', 'FAIL') AS RESULT,
       COUNT(*) AS ROW_CNT, COUNT(DISTINCT HEM) AS DISTINCT_HEMS
FROM DIM_RESPONDENT_DEMOGRAPHICS;

-- A2. AA hit-rate on resolved respondent HEMs meets threshold (findings: ~92.5%).
SELECT 'A2 AA coverage >= 85%' AS ASSERTION,
       IFF(matched / NULLIF(resolved, 0) >= 0.85, 'PASS', 'FAIL') AS RESULT,
       resolved, matched, ROUND(matched / NULLIF(resolved, 0), 3) AS HIT_RATE
FROM (
    SELECT
        (SELECT COUNT(DISTINCT HEM) FROM DIM_RESPONDENT_IDENTITY WHERE HEM IS NOT NULL) AS resolved,
        (SELECT COUNT(*) FROM DIM_RESPONDENT_DEMOGRAPHICS) AS matched
);

-- A3. Banded age only — never a raw integer leaking through AGE_BAND.
SELECT 'A3 age is banded' AS ASSERTION,
       IFF(COUNT_IF(AGE_BAND NOT IN ('18-34','35-44','45-54','55-64','65+')
                    AND AGE_BAND IS NOT NULL) = 0, 'PASS', 'FAIL') AS RESULT
FROM DIM_RESPONDENT_DEMOGRAPHICS;

-- A4. No direct-PII columns in the contract (name / address / ZIP / lat-long /
--     plaintext email / census). The view's column set must stay non-identifying.
SELECT 'A4 no direct-PII columns' AS ASSERTION,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS RESULT,
       LISTAGG(COLUMN_NAME, ', ') AS OFFENDING
FROM MCC_RAW.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'MARKETING_DEV'
  AND TABLE_NAME = 'DIM_RESPONDENT_DEMOGRAPHICS'
  AND (
      COLUMN_NAME ILIKE '%NAME%'
   OR COLUMN_NAME ILIKE '%ADDRESS%'
   OR COLUMN_NAME ILIKE '%ZIP%'
   OR COLUMN_NAME ILIKE '%LAT%'
   OR COLUMN_NAME ILIKE '%LON%'
   OR COLUMN_NAME ILIKE '%EMAIL%'
   OR COLUMN_NAME ILIKE '%CENSUS%'
   OR COLUMN_NAME ILIKE '%PHONE%'
  );
