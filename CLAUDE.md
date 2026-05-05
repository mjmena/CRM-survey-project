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

The `extract_poll_id` step handles both the Snowflake new-row trigger shape (`event.POLL_ID`) and the HTTP trigger shape (`event.body.POLL_ID`).

## Pipeline shape

```
Braze survey catalog
   → sync-braze-to-snowflake → DIM_SURVEY_CATALOG
   → taxonomy-classification (Claude)  → DIM_SURVEY_TAXONOMY
   → V_AMPLITUDE_SURVEY_SYNC (per-user rollup)
   → Amplitude user properties
   → Braze attributes (segmentation/personalization)
```

## Workflows

| Workflow | ID | Notes |
|---|---|---|
| **Braze → Snowflake catalog sync** | `sync-braze-to-snowflake-p_V9CgJMd` | Pulls Braze `crm_surveys` catalog, flattens questions+options, upserts `DIM_SURVEY_CATALOG` (key: `poll_id` + `question_key` + `option_value`) |
| **Taxonomy classification** | `taxonomy-classification-p_WxCpYWv` | Polls every 15 min for new poll_ids, sends full poll context + existing taxonomy paths to Claude for consistency, merges into `DIM_SURVEY_TAXONOMY` |
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

In `MCC_RAW.MARKETING_DEV`:

- `DIM_SURVEY_CATALOG` — source-of-truth questions+options synced from Braze.
- `DIM_SURVEY_TAXONOMY` — Claude-generated bucket / path-or-key/value / confidence per option. Has `IS_APPROVED` boolean column used in backfill/reporting queries to filter to only approved classifications.
- `STG_SURVEY_RESPONSES` — raw response events; joined to taxonomy for per-user rollup.
- `V_AMPLITUDE_SURVEY_SYNC` — 3-column shape (`DEVICE_ID`, `USER_PROPERTY`, `USER_PROPERTY_VALUE`) that Amplitude ingests.

Backfill scripts: `backfill.sql`, `backfill_stage3.sql`.

## classify-taxonomy local script (legacy)

`classify-taxonomy/classify.js` is a standalone Node.js script predating the current Pipedream workflow. Its schema diverges from live — it uses `lowercase_snake_case` paths and lacks the demographic `key/value/type` fields. Do not use it as a reference for the current classification format. It requires `ANTHROPIC_API_KEY` and a JSON export from Snowflake:

```bash
cd classify-taxonomy && npm install
# Export catalog first: snowsql -q "SELECT POLL_ID, QUESTION_KEY, QUESTION_TEXT, OPTION_VALUE, OPTION_LABEL FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_CATALOG" --format json > catalog.json
node classify.js --input catalog.json --dry-run
```
