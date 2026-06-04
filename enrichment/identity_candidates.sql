-- Issue #7, Module 1 — per-response identity candidates (the heavy, windowed part).
-- Invoked by enrichment/refresh-identity.mjs via:
--   snowsql -o variable_substitution=true -o output_format=json -o friendly=false \
--     -o header=false -o timing=false -f enrichment/identity_candidates.sql \
--     -D poll_id=<poll> -D win_start=<YYYY-MM-DD> -D win_end=<YYYY-MM-DD>
--
-- Emits ONE row per response with the RAW payload external_id and the RAW
-- events-recovered USER_ID. Precedence, normalization and validation are applied
-- downstream by the unit-tested resolve-identity.js (seam (a)); this script's only
-- job is the expensive collapse that MUST live in SQL:
--   * window EVENT_TIME to the Poll's submission range so the 55B-row scan is pruned;
--   * collapse a device's many event USER_IDs to ONE deterministic person —
--     most-frequent in the window, tie-broken by most-recent EVENT_TIME (story 14).
-- Responses with no device_id still appear (RECOVERED_USER_ID NULL) so payload-only
-- and unresolved responses survive into DIM_RESPONDENT_IDENTITY.

WITH resp AS (
    SELECT
        INGESTION_ID,
        NULLIF(RAW_DATA:device_id::STRING, '')   AS DEVICE_ID,
        NULLIF(RAW_DATA:external_id::STRING, '')  AS PAYLOAD_EXTERNAL_ID
    FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES
    WHERE POLL_ID = '&poll_id'
),
dev_user AS (   -- one recovered USER_ID per device: most-frequent, then most-recent
    SELECT DEVICE_ID, USER_ID
    FROM (
        SELECT
            e.DEVICE_ID                          AS DEVICE_ID,
            e.USER_ID                            AS USER_ID,
            ROW_NUMBER() OVER (
                PARTITION BY e.DEVICE_ID
                ORDER BY COUNT(*) DESC, MAX(e.EVENT_TIME) DESC
            )                                    AS RN
        FROM MCC_AMPLITUDE.AMPLITUDE.EVENTS_412949 e
        WHERE e.EVENT_TIME BETWEEN '&win_start' AND '&win_end'
          AND e.DEVICE_ID IN (SELECT DEVICE_ID FROM resp WHERE DEVICE_ID IS NOT NULL)
          AND e.USER_ID IS NOT NULL
        GROUP BY e.DEVICE_ID, e.USER_ID
    )
    WHERE RN = 1
)
SELECT
    r.INGESTION_ID          AS INGESTION_ID,
    r.DEVICE_ID             AS DEVICE_ID,
    r.PAYLOAD_EXTERNAL_ID   AS PAYLOAD_EXTERNAL_ID,
    du.USER_ID              AS RECOVERED_USER_ID
FROM resp r
LEFT JOIN dev_user du ON du.DEVICE_ID = r.DEVICE_ID;
