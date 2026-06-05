-- Issue #7, Module 1 — Respondent Identity Resolution.
-- Run: snowsql -f migration/respondent_identity_ddl.sql
--
-- DIM_RESPONDENT_IDENTITY materializes, ONCE per Poll, the hashed-email (HEM)
-- behind each survey response. The 55B-row MCC_AMPLITUDE.AMPLITUDE.EVENTS_412949
-- scan that recovers a HEM from a device_id is windowed to the Poll's submission
-- range and run at refresh time only (stories 12/13) — never at report time.
--
-- Grain: one row per response (INGESTION_ID, the STG_SURVEY_RESPONSES PK), so a
-- shared device resolves to a single deterministic person and a response is never
-- duplicated across identities (story 14). Unresolved responses are still stored
-- with HEM = NULL so downstream surfaces reconcile with the tally grids (story 9).
--
-- Refresh is parameterized by POLL_ID + date window and performed by
-- enrichment/refresh-identity.mjs (seam (a): the windowed collapse stays in SQL
-- via enrichment/identity_candidates.sql; payload-vs-events precedence and HEM
-- normalization are applied by the unit-tested enrichment/resolve-identity.js).
-- This fits the ADR-0001 explicit-handoff pattern: the runner lifts into a
-- Pipedream step unchanged when the refresh is promoted to a handoff workflow.

USE SCHEMA MCC_RAW.MARKETING_DEV;

CREATE TABLE IF NOT EXISTS DIM_RESPONDENT_IDENTITY (
    INGESTION_ID  NUMBER(38,0) NOT NULL,          -- = STG_SURVEY_RESPONSES.INGESTION_ID (one row per response)
    POLL_ID       VARCHAR      NOT NULL,
    DEVICE_ID     VARCHAR,                          -- poll-widget UUID; NULL on device-less responses
    HEM           VARCHAR,                          -- SHA-256 hashed email (lowercase hex); NULL when unresolved
    HEM_SOURCE    VARCHAR,                          -- 'payload' | 'events' | NULL  (how HEM was resolved, story 10)
    PUBLICATION_NAME VARCHAR,                        -- survey-interaction publication (the Market), from the device's [Guides-Surveys] events; full name e.g. 'Miami Herald'. NULL when no guide event in window. Lives here because it falls out of the SAME windowed events scan keyed by device — it is recovered context, not identity.
    RESOLVED_AT   TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT PK_DIM_RESPONDENT_IDENTITY PRIMARY KEY (INGESTION_ID)
)
COMMENT = 'Issue #7 Module 1: per-response hashed-email (HEM) resolution, materialized once per Poll over a windowed events scan. HEM is the canonical respondent key for the enrichment layer.';

-- Post-refresh verification (run after refresh-identity.mjs for a Poll):
--   SELECT HEM_SOURCE, COUNT(*) rows, COUNT(HEM) resolved
--   FROM DIM_RESPONDENT_IDENTITY WHERE POLL_ID = '<poll>' GROUP BY 1 ORDER BY 1;
-- Invariants (cross-check of the resolve-identity.js rules in SQL):
--   - every stored HEM is 64 lowercase hex chars;
--   - HEM_SOURCE = 'payload' iff HEM came from the response payload external_id;
--   - exactly one row per INGESTION_ID.
