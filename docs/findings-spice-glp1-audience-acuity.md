# SPICE GLP-1 poll → Audience Acuity enrichment — findings

Poll: `sf-generation-life-spice-poll` (4 questions: GLP-1 usage status, flavor appeal shifts, functional-ingredient purchase likelihood).
Responses in `MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES`: **2,284** total.

## The identity question, answered

Each response payload carries three identifiers:

| field | populated | what it is |
|---|---|---|
| `device_id` | 2,263 / 2,284 (99%) | poll-widget UUID |
| `external_id` | 681 / 2,284 (**30%**) | **SHA-256 hashed email** |
| `market_name` | 714 / 2,284 (31%) | McClatchy market at submit time |

**`device_id` is a dead end for offline enrichment.** Of 1,528 distinct device_ids, exactly **1** appears in the FullContact identity tables and the curated `AMPLITUDE_EVENTS_DEMOGRAPHICS` table (which also has no 2026 rows — it is stale). The poll widget's device_id is not in the same namespace the offline identity graph keys on, and raw Amplitude events are split per market-project.

**`external_id` (hashed email) is the golden key.** It joins directly to the Audience Acuity data lake:
`external_id` → `AUDIENCE_IDENTITY.EMAIL.SHA256` → `EMAIL.ID` → AA person tables.

## Coverage (the headline)

- 455 distinct hashed emails → **421 match Audience Acuity (92.5%)**.
- 352 distinct AA person IDs resolved.
- Of those: **97%** carry full demographics in `AUDIENCE_IDENTITY.DATA`, **99.7%** carry geography in `AUDIENCE_IDENTITY.PII`.

Net: roughly **30% of all SPICE responses** are demographically enrichable today — gated entirely by whether `external_id` was captured. Lift that capture rate and coverage rises proportionally.

## What Audience Acuity unlocks (keyed on `EMAIL.ID`)

- `AUDIENCE_IDENTITY.DATA` (436M) — age, birth year, income (HH + midpoint), net worth, home owner/value, education, occupation, ethnicity, marital status, children, investments, EAGLES segments.
- `AUDIENCE_IDENTITY.PII` (497M) — state, zip, lat/long, DMA, census tract, gender, birth month/year.
- `FINANCIAL`, `AUTO`, `PROPERTIES`, `BEHAVIORS` (2.7B), `B2C_SIGNALS` (23B) — deeper financial / vehicle / property / behavioral & affinity signals.
- Affinity/interest also available zip-level (`AUDIENCE_IDENTITY.ZIP_INTERESTS`) and via FullContact `KNOWN_USER_TOPIC_INTEREST` / `NAVIGA_SUBSCRIBERS_INTERESTS`.

## Actual profile of matched SPICE respondents (n≈342)

- **Age** skews older: 65+ = 140, 55-64 = 81, 45-54 = 57, 35-44 = 35, 18-34 = 12.
- **Income**: modal band $100–150K (69); long tail up through $1MM+.
- **Net worth**: largest bucket >$500K (100).
- **Home owner**: 274 owners vs 29 renters.
- **Education**: 150 completed college, 44 grad school.
- **Married**: 140 married / 161 not.
- **Top states**: FL 34, CA 23, NY 22, PA 20, TX 19.
- **Top poll markets**: McClatchyDC 242, Miami 91, KansasCity 43, Sacramento 43.

## UPDATE — device_id → email recovery solved (30% → 97%)

The 30% ceiling is lifted by recovering the email from `device_id` through **raw Amplitude events**. Every poll respondent fired events (incl. feature-flag exposure) during the run window, and those events carry `USER_ID` == the SHA-256 hashed email.

Bridge: `device_id` → `MCC_AMPLITUDE.AMPLITUDE.EVENTS_412949.USER_ID` (windowed on `EVENT_TIME`) → hashed email → `AUDIENCE_IDENTITY.EMAIL.SHA256` → AA.

**Why it failed before:** `EVENTS_412949` is 55B rows; an unbounded device join times out / returns ~nothing. Filtering `EVENT_TIME` to the poll window (`2026-05-29`..`2026-06-03`) prunes it and makes the join trivial.

Validation (ground truth = the 456 devices that *also* carried a payload `external_id`):
- **456 / 456** found in events, and `USER_ID` == the known hashed email for **all 456**.
- Device-only responses (no payload email): **1,070 / 1,072 (99.8%)** recovered a `USER_ID`.

End-to-end: **1,528 distinct devices → 1,489 match Audience Acuity (97%)** — a **3.5× lift** over the 421 from payload `external_id` alone. (1,594 recovered emails > 1,528 devices: shared/re-identified devices map to >1 person.)

### Recommendation
1. Enrich via the windowed `EVENTS_412949` device→`USER_ID` recovery (above) — no widget change required; gets ~97%.
2. Optionally still push the poll widget to emit `external_id` to make enrichment instant/self-contained.
3. `AMPLITUDE_PID_USER_SYNC` (PID/SHA256_EMAIL, no device column) is NOT a device bridge — discard that idea.

Reusable query: `spice_aa_enrich.sql` (repo root).
