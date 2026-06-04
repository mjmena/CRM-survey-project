# Consolidate Sheets reporting into a per-survey worker + orchestrator fan-out

**Context.** Two near-duplicate workflows write survey results to Google Sheets:
`Sync to Google Sheet` (`p_LQCoVRY`) and `Surveyfast Sync to Google Sheet`
(`p_xMC9dJJ`, the `copy-of-…` dir). Each runs on a 15-min timer, queries **all polls
at once**, and writes every survey's tab to a single sheet. Issue #7 added a per-response
"Responses + Demographics" tab to both. That per-row export pulls **one row per response
across all polls** (~99k rows), which overflowed Pipedream's **128 MB inter-step payload
limit** (`Decompressed payload exceeds 134217728 bytes`). A stopgap now filters the export
query to enriched polls (those with `DIM_RESPONDENT_IDENTITY` rows), which bounds it today.
But the underlying shape is wrong on two axes: a single run processes **all** polls (payload
grows with the dataset and a single large poll can re-breach the cap), and the two workflows
— including the issue-#7 steps and the duplicated `transform.mjs` — are maintained in parallel.

**Decision.** Consolidate to **one parameterized worker + one orchestrator**, using the
explicit-handoff fan-out already established for classification (see ADR-0001):

- **Report-one-survey worker** — HTTP-triggered, takes `{poll_id, spreadsheet_id}`. Queries
  tallies + demographics **for that poll only** and writes its tally tab + "Responses +
  Demographics" tab to that sheet. One survey per run ⇒ the payload is inherently bounded
  and can never hit the 128 MB cap, regardless of how many surveys exist.
- **Orchestrator** — timer-triggered. Holds the survey→sheet **mapping** and POSTs
  `{poll_id, spreadsheet_id}` per entry to the worker (same shape as
  `migration/fire_backfill.sh`).

**Build by repurposing, not creating.** git cannot create workflows, and it isn't needed:
turn one existing workflow into the worker (add an HTTP trigger via REST; parameterize its
queries on `{poll_id}`) and the other into the orchestrator (timer → loop → POST). The two
sheets (`19pUJyXD…`, `1ycxK2pQ…`) become two entries in the mapping; the duplicate workflow
and the duplicated step code are retired. The single worker carries one `transform.mjs`.

**Mapping location.** Start with a JS array in the orchestrator step — the source of truth
for which surveys report to which sheet. A Snowflake config table is a later option if the
mapping needs to be data-driven.

**Rejected alternatives.**
- *Keep all-polls-per-run + the enriched-polls filter (the stopgap).* Bounds the payload
  today but it still grows per enriched poll, a single large poll can re-breach, and it
  leaves both the duplication and the two-sheets sprawl in place.
- *Raise `lambda_memory`.* Irrelevant — 128 MB is a platform **payload** cap between steps,
  not lambda memory (a memory bump to 2048 did not and cannot fix it).
- *Merge build+write to halve the stored payload.* Reduces but does not **bound** it; still
  one run over all polls.

**Sequencing.** Build the worker first and verify per-survey output to a sheet; then the
orchestrator fan-out; then retire the duplicate workflow. The stopgap filter keeps current
reporting alive throughout the transition.

## Addendum — decisions made during implementation (#11–#13)

- **Write strategy: full resync (both sections).** The human-in-the-loop call required by
  #11. Per-poll scoping already removes the "resync is too heavy" motivation (the weight was
  the all-polls aggregate). More decisively, identity enrichment runs *asynchronously after*
  responses land (`refresh-identity.mjs`), so append-only would write rows with the
  demographics that existed at arrival — almost always none — and never backfill them,
  leaving the demographic columns permanently blank and defeating issue #7. Resync is what
  makes the demographics actually populate; it is also self-healing if a tab is hand-edited.

- **One stacked tab per poll, in survey order.** The two per-poll tabs (aggregate tally +
  per-response "Responses + Demographics") were consolidated into a single `Survey <poll>`
  tab: the tally on top, then a divider, then the per-response grid. The per-response grid
  **leads with the poll answers, then the demographic columns**. Both sections order
  questions by **survey order**, derived from the answer index in the raw responses
  (`MIN(a.index)`, carried as `QUESTION_ORDER`) rather than alphabetically. The two build
  steps and two write steps collapse into one each; the worker carries the single
  `build_survey_grid/transform.mjs`.

- **Mapping: curated prefix split.** The orchestrator's starting mapping sends substantive
  CRM surveys to the CRM sheet (`19pUJyXD…`) and SurveyFast generation polls to the
  SurveyFast sheet (`1ycxK2pQ…`), omitting test/template polls and tiny (<~100 response)
  strays. This ends the prior all-polls-to-both duplication; the mapping array is the single
  source of truth and is trivially editable.

- **Fan-out is sequential, fire-and-forget.** The worker's `http-new-requests` source
  self-responds immediately, so a 2xx POST means "accepted," not "sheet written." The
  orchestrator collects per-survey POST failures and throws; worker run failures surface via
  the worker's own `error_notification`. Concurrent worker runs can briefly race on first-run
  tab creation for a shared sheet, which resync self-heals on the next cycle.
