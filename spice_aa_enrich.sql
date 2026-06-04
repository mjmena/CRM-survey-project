-- SPICE GLP-1 poll → Audience Acuity (AA) demographic enrichment
-- Bridge: survey external_id (SHA-256 hashed email) → AUDIENCE_IDENTITY.EMAIL.SHA256 → EMAIL.ID → AA person tables
-- AA person tables (all keyed on numeric ID = EMAIL.ID):
--   AUDIENCE_IDENTITY.DATA  (436M) — age/income/networth/education/ethnicity/homeowner/occupation/children  [97% of matched]
--   AUDIENCE_IDENTITY.PII   (497M) — name/address/state/zip/lat-long/DMA/census/gender/birth_month            [99.7% of matched]
--   AUDIENCE_IDENTITY.FINANCIAL, BEHAVIORS, AUTO, PROPERTIES, B2C_SIGNALS — deeper signals & affinities
-- NOTE: device_id from the poll payload does NOT join to these offline tables; only the hashed email does.

-- IDENTITY RECOVERY (the lever): device_id → email even when the payload external_id is blank.
-- Raw Amplitude events carry USER_ID == the SHA-256 hashed email. MUST window EVENT_TIME to the
-- poll's run dates (55B-row table; unbounded scan times out and returns ~nothing).
-- Validated: 456/456 devices with a known payload external_id had USER_ID == that exact hash;
-- 1070/1072 device-only responses also recovered. End-to-end SPICE coverage 30% → 97%.

CREATE OR REPLACE TRANSIENT TABLE MCC_RAW.MARKETING_DEV.TMP_SPICE_AA AS
WITH devices AS (
  SELECT DISTINCT RAW_DATA:device_id::string AS dev
  FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES
  WHERE POLL_ID='sf-generation-life-spice-poll' AND RAW_DATA:device_id::string <> ''
),
hems AS (  -- emails recovered from events (covers device-only responses) + any payload emails
  SELECT DISTINCT LOWER(e.USER_ID) AS hem
  FROM MCC_AMPLITUDE.AMPLITUDE.EVENTS_412949 e
  WHERE e.EVENT_TIME BETWEEN '2026-05-29' AND '2026-06-03'   -- SPICE poll window
    AND e.DEVICE_ID IN (SELECT dev FROM devices)
    AND e.USER_ID IS NOT NULL
  UNION
  SELECT DISTINCT LOWER(RAW_DATA:external_id::string)
  FROM MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES
  WHERE POLL_ID='sf-generation-life-spice-poll' AND RAW_DATA:external_id::string <> ''
)
SELECT DISTINCT e.ID AS aa_id
FROM hems h
JOIN MCC_PRESENTATION.AUDIENCE_IDENTITY.EMAIL e ON LOWER(e.SHA256)=h.hem;

-- Demographic profile
SELECT 'AGE_BAND' dim,
       CASE WHEN AGE<35 THEN '18-34' WHEN AGE<45 THEN '35-44' WHEN AGE<55 THEN '45-54'
            WHEN AGE<65 THEN '55-64' WHEN AGE>=65 THEN '65+' ELSE '(unknown)' END val,
       COUNT(*) n
FROM MCC_RAW.MARKETING_DEV.TMP_SPICE_AA t
JOIN MCC_PRESENTATION.AUDIENCE_IDENTITY.DATA d ON d.ID=t.aa_id
GROUP BY 1,2
UNION ALL SELECT 'INCOME_HH', COALESCE(d.INCOME_HH,'(unknown)'), COUNT(*)
  FROM MCC_RAW.MARKETING_DEV.TMP_SPICE_AA t JOIN MCC_PRESENTATION.AUDIENCE_IDENTITY.DATA d ON d.ID=t.aa_id GROUP BY 2
UNION ALL SELECT 'NET_WORTH_HH', COALESCE(d.NET_WORTH_HH,'(unknown)'), COUNT(*)
  FROM MCC_RAW.MARKETING_DEV.TMP_SPICE_AA t JOIN MCC_PRESENTATION.AUDIENCE_IDENTITY.DATA d ON d.ID=t.aa_id GROUP BY 2
ORDER BY 1,3 DESC;
