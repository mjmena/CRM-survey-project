# Respondent demographic enrichment (issue #7)

A surface-agnostic layer that attaches Audience Acuity (AA) demographics to individual
survey responses. The Google Sheet per-survey `Survey <poll>` tab is the first consumer
(the demographics ride below the tally in one stacked tab — see ADR-0003); a future Prism
dashboard (ADR-0002 surface) would read the same views. Read-only — it does **not** feed
Amplitude/Braze (`V_AMPLITUDE_SURVEY_SYNC` is unchanged).

## Modules

| Module | Object | Grain | Notes |
|---|---|---|---|
| 1. Identity | `DIM_RESPONDENT_IDENTITY` (table) | one row per response | `HEM` (SHA-256 hashed email) + `HEM_SOURCE`. Materialized once per Poll. |
| 2. Demographics | `V_RESPONDENT_DEMOGRAPHICS` (view) → `DIM_RESPONDENT_DEMOGRAPHICS` (table) | one row per HEM | Fixed non-identifying contract (below). The view's AA join is a ~150s 497M-row scan, so it's **materialized** into the table at refresh time; the export reads the table. |
| 3. Per-row export | `V_SURVEY_RESPONSE_DEMOGRAPHICS` (view) | one row per response | Answers as an `ANSWERS` object; wide pivot done in JS. Reads the materialized table so each sync is cheap. |
| 4. Sheets writer | report-one-survey worker (per-survey) + orchestrator fan-out (ADR-0003) | one stacked tab per poll | `build_survey_grid/transform.mjs` (pure) builds the tally + per-response grid into one `Survey <poll>` tab. |

## Refresh (Module 1)

The 55B-row `MCC_AMPLITUDE.AMPLITUDE.EVENTS_412949` scan that recovers a HEM from a
`device_id` is **windowed to the Poll's submission range and run only at refresh time**.

```bash
node enrichment/refresh-identity.mjs <POLL_ID> [--pad <days>]   # default pad = 1 day
```

Seam (a): the heavy windowed device→USER_ID collapse stays in SQL
(`identity_candidates.sql`, one deterministic USER_ID per device); payload-vs-events
precedence + HEM normalization live in the unit-tested `resolve-identity.js`. Lifts into
a Pipedream explicit-handoff step (ADR-0001) unchanged. Refresh **promptly after a Poll's
ingestion window** — recovery depends on raw events still being in retention.

After writing identity, the runner also rebuilds `DIM_RESPONDENT_DEMOGRAPHICS` (the ~150s
AA join), so that cost lands at refresh time, not on every Sheets sync. The Sheet picks up
new enrichment only after a refresh — it does **not** recompute identity itself.

## Demographic contract (`V_RESPONDENT_DEMOGRAPHICS`)

Fixed, **non-identifying** columns keyed on `HEM`. Banded/categorical values, geography no
finer than STATE/DMA:

`AGE_BAND`, `GENERATION`, `INCOME_HH`, `NET_WORTH_HH`, `EDUCATION`, `OCCUPATION_CATEGORY`,
`MARITAL_STATUS`, `HOME_OWNER`, `ETHNIC_GROUP`, `HAS_CHILDREN_HH`, `GENDER`, `STATE`,
`DMA`, `AFFINITY_INVESTOR`, `AFFINITY_HOMEOWNER`.

**Never** name, street address, ZIP, lat/long, census, plaintext email, religion, language.
The assertion script enforces no direct-PII columns. The Sheet header IS this contract — the
`DEMOGRAPHIC_COLUMNS` constant in `build_survey_grid/transform.mjs` mirrors it (these columns
trail the poll answers in the per-response grid).

## Tests & assertions

- `npm test` (vitest) — `resolve-identity.test.js`, `test/build-survey-grid.test.js`.
- `snowsql -f migration/assert_respondent_demographics.sql` (Module 2 PASS/FAIL).
- `snowsql -f migration/assert_survey_response_demographics.sql` (Module 3 PASS/FAIL).

## Validated coverage (SPICE GLP-1)

2,284 responses → 2,260 resolved a HEM (99%); 1,421 distinct HEMs match AA (93.7% hit rate);
age enriched on 1,561 responses (68%). See `docs/findings-spice-glp1-audience-acuity.md`.

## Follow-ups (out of scope here)

- **Richer affinity/interest** — v1 affinity is thin (DATA-row flags only). `B2C_SIGNALS`
  (23B), `BEHAVIORS`, `ZIP_INTERESTS` are a follow-up; adding them must keep the column
  contract stable and cost bounded.
- **Promote refresh to a Pipedream explicit-handoff workflow** (ADR-0001) so identity is
  materialized automatically after a Poll's ingestion window.
- **Events projects beyond `EVENTS_412949`** — Polls whose markets live in another Amplitude
  project table won't recover via events (flagged risk in the PRD).
- **Internal Prism dashboard** — deferred to the ADR-0002 approval surface; it reads
  `V_SURVEY_RESPONSE_DEMOGRAPHICS` directly.
