# AI Taxonomy Classification System for CRM Surveys

## Overview

Survey responses collected via Braze are classified into standardized user-profile attributes using AI, then synced to Amplitude (and subsequently Braze) for segmentation and personalization.

**Owners:** Johnna Logan, Marty Mena, James Vermylen
**Technical partner (Amplitude/Snowflake ingestion):** Chad Bruton

## Three Insight Buckets

| Bucket | Format | Example |
|--------|--------|---------|
| **Consumption** | Array of pipe-delimited taxonomy strings (Title Case) | `Real Estate\|Home Renovation`, `Wellness\|Supplements` |
| **Preference** | Array of pipe-delimited taxonomy strings (Title Case) | `Sports\|Soccer\|World Cup 2026\|Brazil`, `Politics\|Engagement\|Undecided` |
| **Demographic** | Explicit key/value pairs (typed) | `retired: true` (boolean), `political_affiliation: "Democrat"` (string) |

**Rules:**
- Taxonomy strings use `Category|Subcategory|Entity|Qualifier...` (variable depth, Title Case, readable)
- Demographics use explicit key/value with typed values (boolean, string, number)
- Concrete-only: we store what users explicitly told us, no inference
- Updates are additive: new answers ADD to arrays, never overwrite

## Data Pipeline

```
Braze crm_prism_surveys catalog → Snowflake (DIM_SURVEY_QUESTIONS + DIM_SURVEY_OPTIONS)
                    ↓
           AI Classification (Claude via Pipedream)
                    ↓
           Snowflake (DIM_SURVEY_TAXONOMY, keyed on OPTION_ID)
                    ↓
           Amplitude Sync View (V_AMPLITUDE_SURVEY_SYNC)
                    ↓
           Amplitude Profile → Braze Attributes
```

Design decisions behind the classification trigger and the (planned) human approval gate
are recorded in [`docs/adr/0001`](docs/adr/0001-classification-trigger-explicit-handoff.md)
and [`docs/adr/0002`](docs/adr/0002-human-approval-gate-before-amplitude.md). The domain
glossary lives in [`CONTEXT.md`](CONTEXT.md).

## Snowflake Schema

All objects live in `MCC_RAW.MARKETING_DEV`. Pull live DDL with
`snowsql -q "SELECT GET_DDL('TABLE','MCC_RAW.MARKETING_DEV.<name>')"` (or `'VIEW'` for the view).

### Catalog: DIM_SURVEY_QUESTIONS + DIM_SURVEY_OPTIONS

The Braze catalog is flattened into two tables (it replaced the retired single
`DIM_SURVEY_CATALOG`):

- **`DIM_SURVEY_QUESTIONS`** — one row per question. PK (`POLL_ID`, `QUESTION_KEY`).
  `QUESTION_TYPE` is `single` / `multi` / `text`.
- **`DIM_SURVEY_OPTIONS`** — one row per answer option, with a surrogate **`OPTION_ID`**
  (autoincrement PK) that everything downstream joins on. Unique on
  (`POLL_ID`, `QUESTION_KEY`, `OPTION_VALUE`). `OPTION_SOURCE` is `catalog` (synced from
  Braze) or `response` (a free-text answer materialized by `text-response-classify`).
  `IS_CATCH_ALL` flags "Other" / "Prefer not to say" style options that are not classified.

### DIM_SURVEY_TAXONOMY

Claude-generated classification, **one or more rows per `OPTION_ID`**:

```sql
OPTION_ID          NUMBER   NOT NULL,   -- FK → DIM_SURVEY_OPTIONS.OPTION_ID
BUCKET             VARCHAR  NOT NULL,   -- 'consumption' | 'preference' | 'demographic'
-- consumption / preference:
TAXONOMY_PATH      VARCHAR,             -- 'Sports|Basketball|March Madness 2026|Duke Blue Devils'
TAXONOMY_DEPTH     NUMBER,              -- number of pipe segments
TAXONOMY_LEVELS    VARIANT,            -- ['Sports','Basketball','March Madness 2026','Duke Blue Devils']
-- demographic:
DEMOGRAPHIC_KEY    VARCHAR,             -- 'retired', 'political_affiliation'
DEMOGRAPHIC_VALUE  VARCHAR,             -- 'true', 'Democrat'
DEMOGRAPHIC_TYPE   VARCHAR,             -- 'boolean' | 'string' | 'number'
CONFIDENCE         FLOAT,               -- 0.0-1.0 from AI
CONDITION_SEQUENCE VARIANT,            -- ordered prerequisite OPTION_IDs for sequence-gated taxonomies
CLASSIFIED_BY      VARCHAR  DEFAULT 'claude',
IS_APPROVED        BOOLEAN  DEFAULT FALSE,   -- human-review gate (see ADR-0002)
CREATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
UPDATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
```

`IS_APPROVED` is currently **decorative** — the sync view does not filter on it yet, so
every classification reaches Amplitude. See
[ADR-0002](docs/adr/0002-human-approval-gate-before-amplitude.md) for the planned gate.

### V_AMPLITUDE_SURVEY_SYNC

Aggregates per-user taxonomy into the 3-column contract for Amplitude ingestion
(`DEVICE_ID`, `USER_PROPERTY`, `USER_PROPERTY_VALUE`). It resolves each answer in
`STG_SURVEY_RESPONSES` to an `OPTION_ID` — handling single-select, multi-select (exploded),
and `response`-sourced text answers — joins to `DIM_SURVEY_TAXONOMY` on `OPTION_ID`, honors
`CONDITION_SEQUENCE` (sequence-gated taxonomies), and excludes catch-alls. The view is
**ungated** today (no `WHERE IS_APPROVED`). See `GET_DDL` for the full definition.

## Pipedream Workflows

Each top-level directory is one GitHub-synced Pipedream workflow; commits to `production`
auto-deploy.

### sync-braze-to-snowflake-p_V9CgJMd — catalog sync

Fetches the Braze `crm_prism_surveys` catalog and flattens it into `DIM_SURVEY_QUESTIONS`
and `DIM_SURVEY_OPTIONS` (`OPTION_SOURCE='catalog'`).

### taxonomy-classification-p_WxCpYWv — classification

Classifies catalog answer options into taxonomy paths / demographic key-value pairs.

**Steps:** `extract_poll_id` → `check_already_classified` / `skip_if_classified` →
`fetch_catalog` (the option rows for the poll) → `fetch_existing_taxonomies` (for
consistency) → `classify_with_ai` (Claude) → `parse_results` → `flatten_results` →
`upsert_taxonomy` (MERGE into `DIM_SURVEY_TAXONOMY`, resolving `OPTION_ID`).

Triggered by HTTP POST (`hi_VOHV2Qx`, body `{"POLL_ID": "..."}`) plus a legacy
`snowflake-new-row` source being retired per
[ADR-0001](docs/adr/0001-classification-trigger-explicit-handoff.md).

### text-response-classify-p_QPC6VBY — free-text classification

Classifies free-text survey answers, materializing `DIM_SURVEY_OPTIONS` rows with
`OPTION_SOURCE='response'` and their taxonomy.

### survey-response-p_LQCoAMR — response ingest

Ingests Braze survey submission events into `STG_SURVEY_RESPONSES`.

### prism-mcp-p_6lCVPoa — MCP connector

Remote MCP server exposing survey/taxonomy tools (e.g. `get_taxonomy`) to Claude. The
future surfacing/approval surface from ADR-0002 is intended to live here.

### sync-to-google-sheet-p_LQCoVRY — reporting

Queries survey response tallies and writes per-survey grids to Google Sheets.

## Query Examples

```sql
-- All preference taxonomies
SELECT * FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY
WHERE BUCKET = 'preference';

-- Sports preferences specifically
SELECT * FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY
WHERE BUCKET = 'preference' AND TAXONOMY_LEVELS[0]::STRING = 'Sports';

-- All demographic key/value mappings
SELECT DEMOGRAPHIC_KEY, DEMOGRAPHIC_VALUE, DEMOGRAPHIC_TYPE, COUNT(*) AS options
FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY
WHERE BUCKET = 'demographic'
GROUP BY 1, 2, 3;

-- Full user profile for a device (simplified: single-select catalog answers only;
-- the production V_AMPLITUDE_SURVEY_SYNC also handles multi-select, text, and CONDITION_SEQUENCE)
SELECT DISTINCT t.BUCKET,
    COALESCE(t.TAXONOMY_PATH, t.DEMOGRAPHIC_KEY || ' = ' || t.DEMOGRAPHIC_VALUE) AS PROFILE_ATTRIBUTE
FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES r
CROSS JOIN LATERAL FLATTEN(input => r.RAW_DATA:answers) a
JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o
  ON o.POLL_ID = r.RAW_DATA:poll_id::STRING
 AND o.QUESTION_KEY = a.value:question::STRING
 AND o.OPTION_VALUE = a.value:answer::STRING
 AND o.OPTION_SOURCE = 'catalog'
JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
  ON t.OPTION_ID = o.OPTION_ID
WHERE r.RAW_DATA:device_id::STRING = :device_id;
```
