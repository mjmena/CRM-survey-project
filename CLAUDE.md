# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@~/.claude/snippets/mcclatchy-stack.md
@~/.claude/snippets/snowflake.md

## What this repo is

A GitHub-synced Pipedream project that classifies CRM survey answer options into a standardized taxonomy with Claude, then aggregates per-user properties for Amplitude → Braze sync. Each top-level dir is one workflow; commits to `production` auto-deploy.

Owners: Johnna Logan, Marty Mena, James Vermylen. Amplitude/Snowflake ingestion partner: Chad Bruton.

## Deployment

Commits to the `production` branch auto-deploy all workflows via Pipedream's GitHub sync. There is no build step — editing `entry.js` files or `workflow.yaml` and pushing is sufficient.

To manually trigger the taxonomy classification workflow for a specific poll (bypasses the 15-min polling cycle):

```
POST <workflow-HTTP-endpoint>
Content-Type: application/json
{"POLL_ID": "crm_some_poll_id"}
```

The `extract_poll_id` step handles both the Snowflake new-row trigger shape (`event.POLL_ID`) and the HTTP trigger shape (`event.body.POLL_ID`). Per **ADR-0001**, the fragile `snowflake-new-row` source is being retired in favor of an explicit handoff POSTed from `sync-braze-to-snowflake` — see `docs/adr/0001-classification-trigger-explicit-handoff.md`.

## Pipeline shape

```
Braze crm_prism_surveys catalog
   → sync-braze-to-snowflake → DIM_SURVEY_QUESTIONS + DIM_SURVEY_OPTIONS
   → taxonomy-classification (Claude)  → DIM_SURVEY_TAXONOMY (keyed on OPTION_ID)
   → V_AMPLITUDE_SURVEY_SYNC (per-user rollup)
   → Amplitude user properties
   → Braze attributes (segmentation/personalization)

Survey submissions feed the same rollup:
   Braze → survey-response (ingest) → STG_SURVEY_RESPONSES
   free-text answers → text-response-classify (Claude) → DIM_SURVEY_OPTIONS (OPTION_SOURCE='response') + DIM_SURVEY_TAXONOMY

Respondent demographic enrichment (issue #7, read-only reporting branch):
   STG_SURVEY_RESPONSES → refresh-identity.mjs (windowed EVENTS_412949 scan) → DIM_RESPONDENT_IDENTITY (HEM per response)
   → V_RESPONDENT_DEMOGRAPHICS (Audience Acuity, non-identifying) keyed on HEM
   → V_SURVEY_RESPONSE_DEMOGRAPHICS (one row per response) → report-one-survey worker → per-survey "Survey <poll>" tab (demographics stacked below the tally)
```

Design decisions behind the trigger and the approval gate are recorded in `docs/adr/`
(`0001` explicit-handoff trigger, `0002` human approval gate). Domain glossary: `CONTEXT.md`.

## Workflows

| Workflow | ID | Notes |
|---|---|---|
| **Braze → Snowflake catalog sync** | `sync-braze-to-snowflake-p_V9CgJMd` | Pulls Braze `crm_prism_surveys` catalog, flattens into `DIM_SURVEY_QUESTIONS` (key: `poll_id` + `question_key`) and `DIM_SURVEY_OPTIONS` (`OPTION_SOURCE='catalog'`, surrogate `OPTION_ID`) |
| **Taxonomy classification** | `taxonomy-classification-p_WxCpYWv` | Sends full poll context + existing taxonomy paths to Claude for consistency, merges into `DIM_SURVEY_TAXONOMY` keyed on `OPTION_ID`. Triggered by HTTP POST (`hi_VOHV2Qx`) plus a legacy `snowflake-new-row` source being retired per ADR-0001 |
| **Text response classify** | `text-response-classify-p_QPC6VBY` | Classifies free-text survey answers; writes new `DIM_SURVEY_OPTIONS` rows with `OPTION_SOURCE='response'` plus their taxonomy |
| **Survey response ingest** | `survey-response-p_LQCoAMR` | Ingests Braze survey submission events into `STG_SURVEY_RESPONSES` |
| **PRISM MCP connector** | `prism-mcp-p_6lCVPoa` | Remote MCP server exposing survey/taxonomy tools (e.g. `get_taxonomy`) to Claude; the future surfacing/approval surface (ADR-0002) builds here |
| **Report One Survey (worker)** | `sync-to-google-sheet-p_LQCoVRY` | HTTP-triggered (`dc_MDuJLd2`), takes `{poll_id, spreadsheet_id}`. Queries tally + demographics **for that one poll**, builds a single stacked `Survey <poll>` tab — tally (questions in survey order) on top, per-response grid below (columns lead with the poll answers, then the demographic contract) — and full-resyncs it to that sheet. One survey per run bounds the payload under the 128 MB cap (ADR-0003). Pure row-transform: `build_survey_grid/transform.mjs` |
| **Report Survey Orchestrator** | `copy-of-sync-to-google-sheet-p_xMC9dJJ` | Timer-triggered. Holds the survey→sheet mapping (a JS array in `fan_out_reports/entry.mjs`, the single source of truth) and POSTs `{poll_id, spreadsheet_id}` to the worker per entry (explicit-handoff fan-out, ADR-0001/0003). Per-survey failures are collected and thrown, not swallowed |

## Workflow step anatomy

Each step is a `defineComponent` export in `<workflow-dir>/<step-name>/entry.js`. Steps receive outputs from prior steps via the `workflow.yaml` props block using `{{steps.<namespace>.$return_value}}` interpolation. Pipedream built-in actions (Snowflake, Anthropic chat) are referenced as `uses: <action-name>@<version>` in `workflow.yaml`; custom logic lives in `entry.js`.

Auth provisioning IDs used across workflows:
- Snowflake: `apn_yghdQYJ` (CRMBOT_SERVICE_USER)
- Braze: `apn_6LhOGA9`
- Anthropic: `apn_Oghan1O`
- Google Sheets: `apn_MGhwj7z`

## The three taxonomy buckets

Every answer is classified into exactly one bucket:

- **Consumption** — what they buy/use. `Title Case|Pipe|Path` (typically 2–4 levels), e.g. `Wellness|Supplements`. Stored as array under Amplitude `consumption_insights`.
- **Preference** — what they like/follow. Same path format, e.g. `Sports|Soccer|World Cup 2026|Brazil`. Amplitude `preference_insights`.
- **Demographic** — facts about who they are. **Not** a path — explicit `key/value/type` (e.g. `political_affiliation = "Democrat"` (string), `retired = true` (boolean)). Each demographic key becomes its own Amplitude property.

## Classification rules (load-bearing)

- **Concrete only** — no inference. "Lakers fan" ≠ "lives in LA".
- **Additive** — new answers append to user arrays; never overwrite.
- **Catch-alls skipped** — "Other", "Prefer not to say", "Something Else", "A different team" → no row written.
- **Consistency** — Claude is fed existing paths so the same concept always uses the same path segment ("Soccer" never "Football").
- `Title Case` + pipe `|` for paths; `snake_case` for demographic keys.
- Confidence scored 0.0–1.0 on every row.
- Polls with segment variants (segment-a/b) get identical classifications.

## Snowflake objects

In `MCC_RAW.MARKETING_DEV` (pull live DDL with `snowsql -q "SELECT GET_DDL('TABLE','MCC_RAW.MARKETING_DEV.<name>')"`):

- `DIM_SURVEY_QUESTIONS` — one row per poll question, synced from Braze. PK (`POLL_ID`, `QUESTION_KEY`); `QUESTION_TYPE` is `single` / `multi` / `text`.
- `DIM_SURVEY_OPTIONS` — one row per answer option. Surrogate PK `OPTION_ID` (autoincrement), unique on (`POLL_ID`, `QUESTION_KEY`, `OPTION_VALUE`). `OPTION_SOURCE` is `catalog` (synced from Braze) or `response` (a free-text answer materialized by `text-response-classify`). `IS_CATCH_ALL` flags options that are skipped from classification/rollup.
- `DIM_SURVEY_TAXONOMY` — Claude-generated bucket / path-or-key/value / confidence, **keyed on `OPTION_ID`** (joins back through `DIM_SURVEY_OPTIONS`). `IS_APPROVED` boolean (default `FALSE`) and `CONDITION_SEQUENCE` (VARIANT; ordered prerequisite `OPTION_ID`s for sequence-gated taxonomies). Per **ADR-0002**, `IS_APPROVED` is currently *decorative* — the sync view does not yet filter on it.
- `STG_SURVEY_RESPONSES` — raw response events; resolved to `OPTION_ID` and joined to taxonomy for per-user rollup.
- `V_AMPLITUDE_SURVEY_SYNC` — 3-column shape (`DEVICE_ID`, `USER_PROPERTY`, `USER_PROPERTY_VALUE`) that Amplitude ingests. Resolves catalog single/multi answers and `response`-sourced text answers to `OPTION_ID`, honors `CONDITION_SEQUENCE`, and excludes catch-alls. **Ungated** today (no `WHERE IS_APPROVED`) — see ADR-0002 for the planned gate.

### Respondent demographic enrichment (issue #7)

A surface-agnostic enrichment layer attaches Audience Acuity demographics to individual responses. The Google Sheet is the first consumer; a future Prism dashboard reads the same views.

- `DIM_RESPONDENT_IDENTITY` — **materialized once per Poll**, one row per response (PK `INGESTION_ID`). Resolves each response to a `HEM` (SHA-256 hashed email — the AA join key) with `HEM_SOURCE` (`payload` | `events` | NULL). The 55B-row `EVENTS_412949` scan that recovers a HEM from `device_id` is **windowed to the Poll's submission range and run only at refresh time** — never at report time. Refresh: `node enrichment/refresh-identity.mjs <POLL_ID> [--pad <days>]` (seam (a): heavy windowed collapse in `enrichment/identity_candidates.sql`; payload-vs-events precedence + HEM normalization in the unit-tested `enrichment/resolve-identity.js`). DDL: `migration/respondent_identity_ddl.sql`.
- `V_RESPONDENT_DEMOGRAPHICS` — keyed on `HEM`; a **fixed, non-identifying** column contract (age band, income/net-worth bands, education, occupation, marital, homeowner, ethnicity, children flag, gender, STATE/DMA, thin affinity flags). Collapses the HEM→AA-person fan-out to one deterministic primary. **Never** exposes name/street/ZIP/lat-long/plaintext email. DDL: `migration/respondent_demographics_ddl.sql`. Affinity is thin in v1 (DATA-row flags only); richer affinity (B2C_SIGNALS etc.) is a documented follow-up.
- `DIM_RESPONDENT_DEMOGRAPHICS` — **materialized** `SELECT *` of the view above. The AA join is a ~150s scan of the 497M-row `EMAIL` table (`SHA256` isn't clustered, so it can't prune) — far too hot to run on every Sheets sync (300s lambda). `refresh-identity.mjs` rebuilds this table at refresh time; `V_SURVEY_RESPONSE_DEMOGRAPHICS` reads **this table**, so each sync is a cheap ~1.4k-row join.
- `V_SURVEY_RESPONSE_DEMOGRAPHICS` — **one row per response** (grain check in the assertion script). Left-joins identity + demographics so unresolved responses still appear with blank demographic columns; carries answers as an `ANSWERS` object (the per-Poll wide pivot is done by the pure JS row-transform, not SQL) plus the payload `market_name`. DDL: `migration/survey_response_demographics_ddl.sql`.

SQL assertions: `migration/assert_respondent_demographics.sql`, `migration/assert_survey_response_demographics.sql` (PASS/FAIL rows; anchored on SPICE). Pure-JS helpers are unit-tested with vitest — run `npm test` from the repo root. Findings/validation: `docs/findings-spice-glp1-audience-acuity.md`.

Backfill scripts: `backfill.sql`, `backfill_stage3.sql`.

## classify-taxonomy local script (legacy)

`classify-taxonomy/classify.js` is a standalone Node.js script predating the current Pipedream workflow. Its schema diverges from live — it uses `lowercase_snake_case` paths and lacks the demographic `key/value/type` fields. Do not use it as a reference for the current classification format. It requires `ANTHROPIC_API_KEY` and a JSON export from Snowflake:

```bash
cd classify-taxonomy && npm install
# Export catalog first: snowsql -q "SELECT o.POLL_ID, o.QUESTION_KEY, q.QUESTION_TEXT, o.OPTION_VALUE, o.OPTION_LABEL FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_QUESTIONS q ON q.POLL_ID=o.POLL_ID AND q.QUESTION_KEY=o.QUESTION_KEY WHERE o.OPTION_SOURCE='catalog'" --format json > catalog.json
node classify.js --input catalog.json --dry-run
```
