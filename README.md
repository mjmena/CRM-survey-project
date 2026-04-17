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
Braze Catalog → Snowflake (DIM_SURVEY_CATALOG)
                    ↓
           AI Classification (Claude via Pipedream)
                    ↓
           Snowflake (DIM_SURVEY_TAXONOMY)
                    ↓
           Amplitude Sync View (V_AMPLITUDE_SURVEY_SYNC)
                    ↓
           Amplitude Profile → Braze Attributes
```

## Snowflake Schema

### DIM_SURVEY_TAXONOMY

```sql
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY (
    POLL_ID            VARCHAR       NOT NULL,
    QUESTION_KEY       VARCHAR       NOT NULL,
    OPTION_VALUE       VARCHAR       NOT NULL,
    BUCKET             VARCHAR       NOT NULL,        -- 'demographic', 'preference', or 'consumption'

    -- For consumption/preference buckets:
    TAXONOMY_PATH      VARCHAR,                       -- 'Sports|Basketball|March Madness 2026|Duke Blue Devils'
    TAXONOMY_DEPTH     INTEGER,                       -- number of pipe segments
    TAXONOMY_LEVELS    VARIANT,                       -- ['Sports','Basketball','March Madness 2026','Duke Blue Devils']

    -- For demographic bucket:
    DEMOGRAPHIC_KEY    VARCHAR,                       -- 'retired', 'political_affiliation'
    DEMOGRAPHIC_VALUE  VARCHAR,                       -- 'true', 'Democrat'
    DEMOGRAPHIC_TYPE   VARCHAR,                       -- 'boolean', 'string', 'number'

    CONFIDENCE         FLOAT,                         -- 0.0-1.0 from AI
    CLASSIFIED_BY      VARCHAR DEFAULT 'claude',
    CREATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    UPDATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

### V_AMPLITUDE_SURVEY_SYNC

Aggregates per-user survey taxonomy into the 3-column contract for Amplitude ingestion (`DEVICE_ID`, `USER_PROPERTY`, `USER_PROPERTY_VALUE`).

```sql
CREATE OR REPLACE VIEW MCC_RAW.MARKETING_DEV.V_AMPLITUDE_SURVEY_SYNC AS

-- Consumption insights (array per user)
SELECT
    r.RAW_DATA:device_id::STRING AS DEVICE_ID,
    'consumption_insights' AS USER_PROPERTY,
    ARRAY_AGG(DISTINCT t.TAXONOMY_PATH)::STRING AS USER_PROPERTY_VALUE
FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES r
CROSS JOIN LATERAL FLATTEN(input => r.RAW_DATA:answers) a
JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
  ON r.RAW_DATA:poll_id::STRING = t.POLL_ID
 AND a.value:question::STRING = t.QUESTION_KEY
 AND a.value:answer::STRING = t.OPTION_VALUE
WHERE t.BUCKET = 'consumption' AND t.TAXONOMY_PATH IS NOT NULL
GROUP BY 1

UNION ALL

-- Preference insights (array per user)
SELECT
    r.RAW_DATA:device_id::STRING AS DEVICE_ID,
    'preference_insights' AS USER_PROPERTY,
    ARRAY_AGG(DISTINCT t.TAXONOMY_PATH)::STRING AS USER_PROPERTY_VALUE
FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES r
CROSS JOIN LATERAL FLATTEN(input => r.RAW_DATA:answers) a
JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
  ON r.RAW_DATA:poll_id::STRING = t.POLL_ID
 AND a.value:question::STRING = t.QUESTION_KEY
 AND a.value:answer::STRING = t.OPTION_VALUE
WHERE t.BUCKET = 'preference' AND t.TAXONOMY_PATH IS NOT NULL
GROUP BY 1

UNION ALL

-- Demographic insights (one row per key per user)
SELECT
    r.RAW_DATA:device_id::STRING AS DEVICE_ID,
    t.DEMOGRAPHIC_KEY AS USER_PROPERTY,
    t.DEMOGRAPHIC_VALUE AS USER_PROPERTY_VALUE
FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES r
CROSS JOIN LATERAL FLATTEN(input => r.RAW_DATA:answers) a
JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
  ON r.RAW_DATA:poll_id::STRING = t.POLL_ID
 AND a.value:question::STRING = t.QUESTION_KEY
 AND a.value:answer::STRING = t.OPTION_VALUE
WHERE t.BUCKET = 'demographic' AND t.DEMOGRAPHIC_KEY IS NOT NULL
GROUP BY 1, 2, 3;
```

## Pipedream Workflows

### taxonomy-classification-p_WxCpYWv

Classifies survey answer options into taxonomy paths and demographic key/value pairs.

**Steps:**
1. `fetch_catalog` — Query DIM_SURVEY_CATALOG from Snowflake
2. `fetch_existing_taxonomies` — Query existing classifications for consistency
3. `classify_with_ai` — Send full poll context to Claude, receive classifications
4. `flatten_results` — Expand multi-classification answers into individual rows
5. `upsert_taxonomy` — MERGE results into DIM_SURVEY_TAXONOMY

### sync-braze-to-snowflake-p_V9CgJMd

Syncs Braze survey catalog to Snowflake DIM_SURVEY_CATALOG.

### sync-to-google-sheet-p_LQCoVRY

Queries survey response tallies and writes to Google Sheets.

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

-- Full user profile for a device
SELECT DISTINCT t.BUCKET,
    COALESCE(t.TAXONOMY_PATH, t.DEMOGRAPHIC_KEY || ' = ' || t.DEMOGRAPHIC_VALUE) AS PROFILE_ATTRIBUTE
FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES r
CROSS JOIN LATERAL FLATTEN(input => r.RAW_DATA:answers) a
JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
  ON r.RAW_DATA:poll_id::STRING = t.POLL_ID
 AND a.value:question::STRING = t.QUESTION_KEY
 AND a.value:answer::STRING = t.OPTION_VALUE
WHERE r.RAW_DATA:device_id::STRING = :device_id;
```
