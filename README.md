# AI Taxonomy Classification System for CRM Surveys

## Context

Survey responses are collected via Braze and stored in Snowflake, but there's no structured way to categorize what a user's answers *mean*. The goal is to map each survey answer option to one or more hierarchical pipe-delimited taxonomies so user profiles can be enriched with structured interest/demographic/consumption tags.

Three predefined buckets stored as a separate field: **demographic**, **preference**, **consumption**. Taxonomy paths represent the category hierarchy below the bucket (e.g., `sports|soccer|world_cup_2026|brazil`). Unlimited variable depth. A single answer can produce multiple taxonomy assignments (across different buckets or within the same one). Not every answer gets a taxonomy (e.g., "Prefer not to say" = no rows).

**Key design principles:**
1. **Poll-level context** — the entire poll (topic, all questions, all answers) informs each taxonomy path
2. **Multiple taxonomies per answer** — "Grand Celebration" hosting style could be both `preference → entertaining|hosting_style|grand_celebration` and `demographic → lifestyle|social_orientation|extroverted`
3. **Existing taxonomy awareness** — when classifying new polls, the AI sees all previously assigned paths to reuse existing categories and maintain naming consistency

**Important constraint:** Pipedream does not support creating new workflows via git push. We'll write the classification script locally first, then integrate into Pipedream once a workflow is created via the UI/API.

---

## Step 1: Create Snowflake Table

Create `MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY` via Snowflake MCP:

```sql
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY (
    POLL_ID            VARCHAR       NOT NULL,
    QUESTION_KEY       VARCHAR       NOT NULL,
    OPTION_VALUE       VARCHAR       NOT NULL,
    BUCKET             VARCHAR       NOT NULL,        -- 'demographic', 'preference', or 'consumption'
    TAXONOMY_PATH      VARCHAR       NOT NULL,        -- 'sports|soccer|world_cup_2026|brazil' (no bucket prefix)
    TAXONOMY_DEPTH     INTEGER,                       -- number of segments (auto-computed)
    TAXONOMY_LEVELS    VARIANT,                       -- ['sports','soccer','world_cup_2026','brazil']
    CONFIDENCE         FLOAT,                         -- 0.0-1.0 from AI
    CLASSIFIED_BY      VARCHAR DEFAULT 'claude',
    CREATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    UPDATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (POLL_ID, QUESTION_KEY, OPTION_VALUE, BUCKET, TAXONOMY_PATH)
);
```

**Why this schema:**
- `BUCKET` — separate constrained column for the three predefined buckets, not part of the taxonomy path
- `TAXONOMY_PATH` — the category hierarchy below the bucket, unlimited depth
- `TAXONOMY_LEVELS` — Snowflake VARIANT array for indexed access at any depth
- **PK includes BUCKET + TAXONOMY_PATH** — one answer can have multiple taxonomy rows (e.g., one in `preference` and one in `demographic`)

**Query patterns:**
```sql
-- All preference taxonomies
WHERE BUCKET = 'preference'

-- All sports preferences
WHERE BUCKET = 'preference' AND TAXONOMY_LEVELS[0]::STRING = 'sports'

-- Full path with bucket
SELECT BUCKET || '|' || TAXONOMY_PATH AS FULL_TAXONOMY FROM ...

-- All taxonomies for a specific answer (may return multiple rows)
WHERE POLL_ID = 'crm_fifa_world_cup_survey_2026_lp'
  AND OPTION_VALUE = 'Brazil'

-- User profile: all taxonomy tags for a user's responses
SELECT DISTINCT t.BUCKET, t.TAXONOMY_PATH
FROM STG_SURVEY_RESPONSES r,
     LATERAL FLATTEN(input => r.RAW_DATA:answers) a
JOIN DIM_SURVEY_TAXONOMY t
  ON r.RAW_DATA:poll_id::STRING = t.POLL_ID
 AND a.value:question::STRING = t.QUESTION_KEY
 AND a.value:answer::STRING = t.OPTION_VALUE
WHERE r.USER_ID = :user_id
```

## Step 2: Create Convenience View

```sql
CREATE OR REPLACE VIEW MCC_RAW.MARKETING_DEV.V_SURVEY_TAXONOMY AS
SELECT
    t.*,
    t.BUCKET || '|' || t.TAXONOMY_PATH AS FULL_TAXONOMY,
    c.QUESTION_TEXT,
    c.OPTION_LABEL
FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
LEFT JOIN (
    SELECT DISTINCT POLL_ID, QUESTION_KEY, OPTION_VALUE, QUESTION_TEXT, OPTION_LABEL
    FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_CATALOG
) c ON t.POLL_ID = c.POLL_ID
   AND t.QUESTION_KEY = c.QUESTION_KEY
   AND t.OPTION_VALUE = c.OPTION_VALUE;
```

## Step 3: Write Classification Script

Create `classify-taxonomy/classify.js` — a Node.js script that:

1. **Fetches unclassified catalog rows** from Snowflake (LEFT ANTI JOIN against DIM_SURVEY_TAXONOMY)
2. **Fetches existing taxonomy paths** from DIM_SURVEY_TAXONOMY — these are included in the AI prompt so new classifications reuse existing categories
3. **Groups unclassified rows by poll_id** — each poll sent as a complete unit
4. **Calls Claude API** with full poll context + existing taxonomy reference
5. **Parses JSON response** and derives TAXONOMY_LEVELS + TAXONOMY_DEPTH from each path
6. **Returns structured output** ready for Snowflake INSERT

### AI Prompt Strategy

**System prompt** defines:
- The three buckets with clear definitions:
  - `demographic` — who the person IS (age, location, political leaning, life stage, outlook)
  - `preference` — what they LIKE or WANT (sports teams, food, travel style, entertainment)
  - `consumption` — what they BUY or USE (purchasing behavior, spending, products, investments)
- `bucket` is a separate field — taxonomy paths do NOT include the bucket as the first level
- Variable-depth rules and `lowercase_snake_case` conventions
- An answer can have **multiple** taxonomy assignments (different buckets or same bucket, different paths)
- Use the **entire poll** as context — poll topic, question wording, answer relationships shape paths
- Null handling for non-informative answers ("Prefer not to say", "Something Else", etc.)

**Existing taxonomy reference** included in each prompt:
```
Here are the taxonomy paths already in use. Reuse these categories and naming
conventions wherever applicable. Do not create new paths that duplicate existing ones.

preference:
  - sports|soccer|world_cup_2026
  - sports|basketball|ncaa|march_madness_2026
  - sports|winter_olympics|2026
  ...

demographic:
  - political|affiliation
  - political|voting_intent
  - life_stage|retirement
  ...

consumption:
  - financial|investment
  - wellness|purchase
  ...
```

**User prompt** sends polls as structured blocks:
```
Survey: crm_fifa_world_cup_survey_2026_lp
Topic context: FIFA World Cup 2026

Questions:
  Q1 [fifa_event_2026]: "Which team will win the world cup 2026?"
    Options: Brazil, Argentina, France, Germany, USA

For each answer option, assign one or more taxonomy classifications.
Each classification needs: bucket (demographic/preference/consumption),
taxonomy_path, and confidence (0-1).
Return null for non-informative catch-all answers.
```

**Response format:** JSON array — note `taxonomies` is an array (supports multiple per answer):
```json
[
  {
    "poll_id": "crm_fifa_world_cup_survey_2026_lp",
    "question_key": "fifa_event_2026",
    "option_value": "Brazil",
    "taxonomies": [
      {"bucket": "preference", "taxonomy_path": "sports|soccer|world_cup_2026|brazil", "confidence": 0.95}
    ]
  },
  {
    "poll_id": "holiday2025_food",
    "question_key": "holiday_hosting_style",
    "option_value": "grand_celebration",
    "taxonomies": [
      {"bucket": "preference", "taxonomy_path": "entertaining|hosting_style|grand_celebration", "confidence": 0.9},
      {"bucket": "demographic", "taxonomy_path": "lifestyle|social_orientation|extroverted", "confidence": 0.7}
    ]
  }
]
```

### Key files to reference for patterns:
- `sync-braze-to-snowflake-p_V9CgJMd/flatten_catalog/entry.js` — Pipedream `defineComponent` structure
- `sync-braze-to-snowflake-p_V9CgJMd/workflow.yaml` — MERGE/upsert SQL pattern with `TABLE(FLATTEN(PARSE_JSON(...)))`

## Step 4: Run Initial Classification

Execute the script against the full catalog (~122 rows across ~19 polls). Review output for:
- Bucket assignments are correct (demographic vs preference vs consumption)
- Multi-taxonomy answers make sense (not over-tagging — only assign multiple when genuinely warranted)
- Taxonomy paths reflect poll context (not just the answer word in isolation)
- Consistent naming across polls (reuses existing paths, e.g., all soccer → `sports|soccer`)
- Appropriate depth — sports team picks deeper than yes/no retirement readiness
- No taxonomy rows for non-informative answers
- Reasonable confidence scores

## Step 5: Upsert Results to Snowflake

INSERT classified rows into `DIM_SURVEY_TAXONOMY`. Since one answer can now produce multiple rows, we use INSERT with a conflict-handling approach:

```sql
MERGE INTO MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY AS tgt
USING (
    SELECT
        s.value:poll_id::STRING        AS POLL_ID,
        s.value:question_key::STRING   AS QUESTION_KEY,
        s.value:option_value::STRING   AS OPTION_VALUE,
        s.value:bucket::STRING         AS BUCKET,
        s.value:taxonomy_path::STRING  AS TAXONOMY_PATH,
        ARRAY_SIZE(SPLIT(s.value:taxonomy_path::STRING, '|')) AS TAXONOMY_DEPTH,
        SPLIT(s.value:taxonomy_path::STRING, '|')             AS TAXONOMY_LEVELS,
        s.value:confidence::FLOAT      AS CONFIDENCE
    FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:json_data))) s
    WHERE s.value:taxonomy_path IS NOT NULL
) AS src
ON  tgt.POLL_ID      = src.POLL_ID
AND tgt.QUESTION_KEY  = src.QUESTION_KEY
AND tgt.OPTION_VALUE  = src.OPTION_VALUE
AND tgt.BUCKET        = src.BUCKET
AND tgt.TAXONOMY_PATH = src.TAXONOMY_PATH
WHEN MATCHED THEN UPDATE SET
    tgt.TAXONOMY_DEPTH  = src.TAXONOMY_DEPTH,
    tgt.TAXONOMY_LEVELS = src.TAXONOMY_LEVELS,
    tgt.CONFIDENCE      = src.CONFIDENCE,
    tgt.UPDATED_AT      = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (POLL_ID, QUESTION_KEY, OPTION_VALUE, BUCKET, TAXONOMY_PATH, TAXONOMY_DEPTH, TAXONOMY_LEVELS, CONFIDENCE)
    VALUES (src.POLL_ID, src.QUESTION_KEY, src.OPTION_VALUE, src.BUCKET, src.TAXONOMY_PATH, src.TAXONOMY_DEPTH, src.TAXONOMY_LEVELS, src.CONFIDENCE);
```

## Step 6: Answer Combinations (Future / Optional)

For multi-question polls (currently only `crm-politics-undecided-voters-poll`), a separate `DIM_SURVEY_TAXONOMY_COMBOS` table can store combination-derived taxonomy:
- Democrat + already decided → `demographic` / `political|profile|committed_partisan`
- Independent + undecided → `demographic` / `political|profile|persuadable_independent`

Deferred until per-answer taxonomy is validated.

---

## Verification

1. **Row count** — query table after upsert; expect >= 122 rows (more due to multi-taxonomy answers)
2. **Spot-check**: `SELECT * FROM V_SURVEY_TAXONOMY ORDER BY POLL_ID, QUESTION_KEY, BUCKET`
3. **Multi-taxonomy check** — verify answers with multiple buckets:
   ```sql
   SELECT POLL_ID, QUESTION_KEY, OPTION_VALUE, COUNT(*) AS taxonomy_count
   FROM DIM_SURVEY_TAXONOMY
   GROUP BY 1, 2, 3
   HAVING COUNT(*) > 1;
   ```
4. **Bucket distribution**:
   ```sql
   SELECT BUCKET, COUNT(*) FROM DIM_SURVEY_TAXONOMY GROUP BY 1;
   ```
5. **Downstream join** — responses enriched with taxonomy:
   ```sql
   SELECT t.BUCKET, t.TAXONOMY_LEVELS[0]::STRING AS category, COUNT(*) AS responses
   FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES r,
        LATERAL FLATTEN(input => r.RAW_DATA:answers) a
   JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
     ON r.RAW_DATA:poll_id::STRING = t.POLL_ID
    AND a.value:question::STRING = t.QUESTION_KEY
    AND a.value:answer::STRING = t.OPTION_VALUE
   GROUP BY 1, 2 ORDER BY 3 DESC;
   ```
6. **No nulls in bucket** — confirm all rows have a valid bucket value
7. **Consistency** — verify "soccer" is always "soccer" (not "football" in some polls)
8. **Poll context** — compare taxonomy for same answer word across different polls
