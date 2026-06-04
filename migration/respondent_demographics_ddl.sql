-- Issue #7, Module 2 — Audience Acuity demographic enrichment.
-- Run: snowsql -f migration/respondent_demographics_ddl.sql
--
-- V_RESPONDENT_DEMOGRAPHICS is keyed on HEM and exposes a FIXED, NON-IDENTIFYING
-- column contract: banded/categorical demographics, geography no finer than
-- STATE/DMA, plus thin affinity flags. This is the data contract the Sheet header
-- and any future Prism dashboard depend on — add columns deliberately, never
-- SELECT * from PII (it carries name / street / ZIP / lat-long). Excluded on
-- purpose: name, address, ZIP, lat/long, census, religion, language, plaintext
-- email (re-identifying and/or unnamed by the PRD).
--
-- Scope: respondents only — built from the resolved HEMs in DIM_RESPONDENT_IDENTITY,
-- so the AA join is bounded to people we actually surveyed (not all 436M AA rows).
--
-- Fan-out collapse (story 14 / grain): a HEM can match multiple AUDIENCE_IDENTITY
-- EMAIL records (-> multiple persons). Collapse to ONE deterministic primary:
-- highest EMAILQUALITYLEVEL, then best (lowest) RANKORDER, then most-recent
-- UPDATEDATE. Exactly one demographics row per HEM => the per-row export grain holds.
--
-- Affinity (story 5) is intentionally THIN in v1: only flags already on the joined
-- DATA row (investor, homeowner). Richer affinity/interest (B2C_SIGNALS 23B,
-- BEHAVIORS, ZIP_INTERESTS) is a documented follow-up — joining them here would
-- destabilize the column contract and blow up cost.

USE SCHEMA MCC_RAW.MARKETING_DEV;

CREATE OR REPLACE VIEW V_RESPONDENT_DEMOGRAPHICS AS
WITH respondent_hems AS (
    SELECT DISTINCT HEM
    FROM MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_IDENTITY
    WHERE HEM IS NOT NULL
),
-- HEM -> one deterministic AA person (EMAIL.ID)
primary_person AS (
    SELECT rh.HEM, em.ID AS AA_ID
    FROM respondent_hems rh
    JOIN MCC_PRESENTATION.AUDIENCE_IDENTITY.EMAIL em
        ON em.SHA256 = rh.HEM   -- both sides are lowercase hex; no LOWER() so the join prunes
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY rh.HEM
        ORDER BY em.EMAILQUALITYLEVEL DESC NULLS LAST,
                 em.RANKORDER ASC NULLS LAST,
                 em.UPDATEDATE DESC NULLS LAST
    ) = 1
)
SELECT
    pp.HEM                                                       AS HEM,

    -- Age: banded, never the raw integer
    CASE
        WHEN d.AGE IS NULL  THEN NULL
        WHEN d.AGE < 35     THEN '18-34'
        WHEN d.AGE < 45     THEN '35-44'
        WHEN d.AGE < 55     THEN '45-54'
        WHEN d.AGE < 65     THEN '55-64'
        ELSE                     '65+'
    END                                                         AS AGE_BAND,
    d.GENERATION                                                AS GENERATION,

    -- Affluence: AA's own banded strings
    d.INCOME_HH                                                 AS INCOME_HH,
    d.NET_WORTH_HH                                              AS NET_WORTH_HH,

    -- Categorical attributes
    d.EDUCATION                                                 AS EDUCATION,
    d.OCCUPATION_CATEGORY                                       AS OCCUPATION_CATEGORY,
    d.MARITAL_STATUS                                            AS MARITAL_STATUS,
    d.HOME_OWNER                                                AS HOME_OWNER,
    d.ETHNIC_GROUP                                              AS ETHNIC_GROUP,
    CASE WHEN d.CHILDREN_HH IS NULL THEN NULL
         ELSE (d.CHILDREN_HH > 0) END                           AS HAS_CHILDREN_HH,
    COALESCE(p.GENDER, d.GENDER)                                AS GENDER,

    -- Geography: STATE / DMA only (no ZIP, no lat-long)
    p.STATE                                                     AS STATE,
    p.DMA                                                       AS DMA,

    -- Affinity flags (thin v1 — DATA-row flags only).
    -- HOME_OWNER_ORDINAL: 1=Renter, 3=Probable Home Owner, 4=Home Owner (NULL=unknown),
    -- so an owner is ordinal >= 3 — NOT > 0 (which would flag renters).
    (d.OWNS_INVESTMENTS = 1)                                    AS AFFINITY_INVESTOR,
    CASE WHEN d.HOME_OWNER_ORDINAL IS NULL THEN NULL
         ELSE (d.HOME_OWNER_ORDINAL >= 3) END                   AS AFFINITY_HOMEOWNER
FROM primary_person pp
LEFT JOIN MCC_PRESENTATION.AUDIENCE_IDENTITY.DATA d ON d.ID = pp.AA_ID
LEFT JOIN MCC_PRESENTATION.AUDIENCE_IDENTITY.PII  p ON p.ID = pp.AA_ID;

-- Materialized serving table. The AA join above is a ~150s scan of the 497M-row
-- EMAIL table (SHA256 is not clustered, so the equality join cannot prune) — far
-- too hot to run on every Google Sheets sync against the 300s lambda budget. So we
-- materialize it ONCE per identity refresh: enrichment/refresh-identity.mjs rebuilds
-- this table after writing DIM_RESPONDENT_IDENTITY, and the per-row export view reads
-- this table (a ~1.4k-row join) instead of the live AA view. Tiny output, full rebuild.
CREATE OR REPLACE TABLE DIM_RESPONDENT_DEMOGRAPHICS AS
SELECT * FROM V_RESPONDENT_DEMOGRAPHICS;

-- Smoke test: coverage + a peek at the banded profile (should echo the SPICE findings)
SELECT
    COUNT(*)                              AS HEMS,
    COUNT(AGE_BAND)                       AS WITH_AGE,
    COUNT(INCOME_HH)                      AS WITH_INCOME,
    COUNT(STATE)                          AS WITH_STATE
FROM DIM_RESPONDENT_DEMOGRAPHICS;
