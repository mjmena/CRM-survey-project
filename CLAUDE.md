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
| **Google Sheets reporting** | `sync-to-google-sheet-p_LQCoVRY` | Tallies response counts per option, writes per-survey grids to Google Sheets (one tab per survey) |

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

Backfill scripts: `backfill.sql`, `backfill_stage3.sql`.

## classify-taxonomy local script (legacy)

`classify-taxonomy/classify.js` is a standalone Node.js script predating the current Pipedream workflow. Its schema diverges from live — it uses `lowercase_snake_case` paths and lacks the demographic `key/value/type` fields. Do not use it as a reference for the current classification format. It requires `ANTHROPIC_API_KEY` and a JSON export from Snowflake:

```bash
cd classify-taxonomy && npm install
# Export catalog first: snowsql -q "SELECT o.POLL_ID, o.QUESTION_KEY, q.QUESTION_TEXT, o.OPTION_VALUE, o.OPTION_LABEL FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_QUESTIONS q ON q.POLL_ID=o.POLL_ID AND q.QUESTION_KEY=o.QUESTION_KEY WHERE o.OPTION_SOURCE='catalog'" --format json > catalog.json
node classify.js --input catalog.json --dry-run
```
