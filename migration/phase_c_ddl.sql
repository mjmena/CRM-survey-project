-- Phase C: Finalize taxonomy table
-- PREREQUISITE: taxonomy-classification workflow must be inactive (deactivated since Phase A).
-- Run: snowsql -f migration/phase_c_ddl.sql

USE SCHEMA MCC_RAW.MARKETING_DEV;

-- ─── Step 1: Seed DIM_SURVEY_TAXONOMY_NEW from DEPRECATED ─────────────────────
-- Resolve OPTION_IDs via JOIN on the seeded DIM_SURVEY_OPTIONS table.
-- Rows in DEPRECATED that don't match an OPTION_VALUE in DIM_SURVEY_OPTIONS are
-- silently dropped (should be none given the tables were seeded from the same source).

INSERT INTO DIM_SURVEY_TAXONOMY_NEW
    (OPTION_ID, BUCKET, TAXONOMY_PATH, TAXONOMY_DEPTH, TAXONOMY_LEVELS,
     DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE, DEMOGRAPHIC_TYPE, CONFIDENCE, IS_APPROVED)
SELECT o.OPTION_ID,
       t.BUCKET, t.TAXONOMY_PATH, t.TAXONOMY_DEPTH, t.TAXONOMY_LEVELS,
       t.DEMOGRAPHIC_KEY, t.DEMOGRAPHIC_VALUE, t.DEMOGRAPHIC_TYPE, t.CONFIDENCE, t.IS_APPROVED
FROM DIM_SURVEY_TAXONOMY_DEPRECATED t
JOIN DIM_SURVEY_OPTIONS o
  ON o.POLL_ID      = t.POLL_ID
 AND o.QUESTION_KEY = t.QUESTION_KEY
 AND o.OPTION_VALUE = t.OPTION_VALUE;

-- Verify seed counts match before proceeding
SELECT 'new_table'   AS src, COUNT(*) AS cnt FROM DIM_SURVEY_TAXONOMY_NEW
UNION ALL
SELECT 'deprecated',          COUNT(*) FROM DIM_SURVEY_TAXONOMY_DEPRECATED;
-- Expect: new_table count = deprecated count (or slightly less if any orphaned rows)

-- ─── Step 2: Drop the back-compat DIM_SURVEY_TAXONOMY view ───────────────────

DROP VIEW IF EXISTS DIM_SURVEY_TAXONOMY;

-- ─── Step 3: Rename DIM_SURVEY_TAXONOMY_NEW → DIM_SURVEY_TAXONOMY ────────────

ALTER TABLE DIM_SURVEY_TAXONOMY_NEW RENAME TO DIM_SURVEY_TAXONOMY;

-- ─── Step 4: Drop the back-compat DIM_SURVEY_CATALOG view ────────────────────
-- Phase B already migrated writes to the real DIM_SURVEY_QUESTIONS/DIM_SURVEY_OPTIONS.

DROP VIEW IF EXISTS DIM_SURVEY_CATALOG;

-- ─── Verification ─────────────────────────────────────────────────────────────

SELECT 'taxonomy' AS tbl, COUNT(*) AS cnt FROM DIM_SURVEY_TAXONOMY
UNION ALL
SELECT 'options',  COUNT(*) FROM DIM_SURVEY_OPTIONS WHERE OPTION_SOURCE = 'catalog'
UNION ALL
SELECT 'questions', COUNT(*) FROM DIM_SURVEY_QUESTIONS;
-- Expect: taxonomy = deprecated row count, options = 138, questions = 29+
