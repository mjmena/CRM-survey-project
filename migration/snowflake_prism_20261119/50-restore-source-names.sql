-- NOT APPLIED. ONLY for rollback after 40-compatibility COMPLETED.
-- Freeze and drain all new and old writers before beginning rollback.
-- First restore the original physical names. Never drop a production table.
-- Original response virtual columns become valid again when its name is restored.
USE ROLE MARKETING_ENGINEER;
USE WAREHOUSE MARKETING_WH;


DROP VIEW MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES;

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES;

DROP VIEW MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS;

ALTER TABLE MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS;

DROP VIEW MCC_RAW.MARKETING_DEV.DIM_SURVEY_QUESTIONS;

ALTER TABLE MCC_RAW.MARKETING_DEV.DIM_SURVEY_QUESTIONS_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.DIM_SURVEY_QUESTIONS;

DROP VIEW MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY;

ALTER TABLE MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY;

DROP VIEW MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_IDENTITY;

ALTER TABLE MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_IDENTITY_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_IDENTITY;

DROP VIEW MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_DEMOGRAPHICS;

ALTER TABLE MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_DEMOGRAPHICS_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.DIM_RESPONDENT_DEMOGRAPHICS;

DROP VIEW MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY_DEPRECATED;

ALTER TABLE MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY_DEPRECATED_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY_DEPRECATED;

DROP VIEW MCC_RAW.MARKETING_DEV.DIM_SURVEY_CATALOG_DEPRECATED;

ALTER TABLE MCC_RAW.MARKETING_DEV.DIM_SURVEY_CATALOG_DEPRECATED_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.DIM_SURVEY_CATALOG_DEPRECATED;

DROP VIEW MCC_RAW.MARKETING_DEV.FCT_RESPONSE_TAXONOMY;

ALTER TABLE MCC_RAW.MARKETING_DEV.FCT_RESPONSE_TAXONOMY_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.FCT_RESPONSE_TAXONOMY;

DROP VIEW MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES_DUPES_20261113;

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES_DUPES_20261113_PRE_PRISM_20261119 RENAME TO MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES_DUPES_20261113;

create or replace view MCC_RAW.MARKETING_DEV.V_AMPLITUDE_SURVEY_SYNC(
	DEVICE_ID,
	USER_PROPERTY,
	USER_PROPERTY_VALUE
) as
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

GRANT SELECT ON VIEW MCC_RAW.MARKETING_DEV.V_AMPLITUDE_SURVEY_SYNC TO ROLE MARKETING_ENGINEER;
GRANT SELECT ON VIEW MCC_RAW.MARKETING_DEV.V_AMPLITUDE_SURVEY_SYNC TO ROLE MCC_MARKETING_AUDIENCE_BUILDER_SFULL;

create or replace view MCC_RAW.MARKETING_DEV.V_RESPONDENT_DEMOGRAPHICS(
	HEM,
	AGE_BAND,
	GENERATION,
	INCOME_HH,
	NET_WORTH_HH,
	EDUCATION,
	OCCUPATION_CATEGORY,
	MARITAL_STATUS,
	HOME_OWNER,
	ETHNIC_GROUP,
	HAS_CHILDREN_HH,
	GENDER,
	STATE,
	DMA,
	AFFINITY_INVESTOR,
	AFFINITY_HOMEOWNER
) as
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

GRANT SELECT ON VIEW MCC_RAW.MARKETING_DEV.V_RESPONDENT_DEMOGRAPHICS TO ROLE MARKETING_ENGINEER;
GRANT SELECT ON VIEW MCC_RAW.MARKETING_DEV.V_RESPONDENT_DEMOGRAPHICS TO ROLE MCC_MARKETING_AUDIENCE_BUILDER_SFULL;

create or replace view MCC_RAW.MARKETING_DEV.V_SURVEY_RESPONSE_DEMOGRAPHICS(
	INGESTION_ID,
	POLL_ID,
	SUBMITTED_AT,
	MARKET_NAME,
	IDENTITY_SOURCE,
	AGE_BAND,
	GENERATION,
	INCOME_HH,
	NET_WORTH_HH,
	EDUCATION,
	OCCUPATION_CATEGORY,
	MARITAL_STATUS,
	HOME_OWNER,
	ETHNIC_GROUP,
	HAS_CHILDREN_HH,
	GENDER,
	STATE,
	DMA,
	AFFINITY_INVESTOR,
	AFFINITY_HOMEOWNER,
	ANSWERS
) as
WITH base AS (
    SELECT
        INGESTION_ID,
        POLL_ID,
        SUBMITTED_AT,
        NULLIF(RAW_DATA:market_name::STRING, '') AS PAYLOAD_MARKET_NAME   -- payload market_name; sparse (0% on CRM/IAM polls) & terse codes ('Miami')
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
    -- Market: the survey-interaction publication (where the survey was actually
    -- shown), recovered from the device's [Guides-Surveys] events at refresh time;
    -- full publication names ('Miami Herald'). Falls back to the sparse payload
    -- market_name only when no guide event was in the window (~2%). Output column
    -- stays MARKET_NAME so the Sheets row-transform needs no change.
    COALESCE(i.PUBLICATION_NAME, b.PAYLOAD_MARKET_NAME) AS MARKET_NAME,
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

GRANT SELECT ON VIEW MCC_RAW.MARKETING_DEV.V_SURVEY_RESPONSE_DEMOGRAPHICS TO ROLE MARKETING_ENGINEER;
GRANT SELECT ON VIEW MCC_RAW.MARKETING_DEV.V_SURVEY_RESPONSE_DEMOGRAPHICS TO ROLE MCC_MARKETING_AUDIENCE_BUILDER_SFULL;
