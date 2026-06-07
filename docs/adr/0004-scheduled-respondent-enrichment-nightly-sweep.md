# Schedule respondent demographic enrichment as a nightly Snowflake TASK DAG

**Context.** Issue #7 shipped respondent enrichment as a manual per-poll runner,
`enrichment/refresh-identity.mjs <POLL_ID>`, run by hand from a laptop via local snowsql.
It does two halves back to back: **(A) identity resolution** — a windowed `EVENTS_412949`
device→`USER_ID` collapse → `resolve-identity.js` → `DIM_RESPONDENT_IDENTITY`; and
**(B) demographics materialization** — `CREATE OR REPLACE TABLE DIM_RESPONDENT_DEMOGRAPHICS
AS SELECT * FROM V_RESPONDENT_DEMOGRAPHICS`, the ~150s 497M-row Audience Acuity `EMAIL`
scan. Because it is manual, the materialized table drifts: identity currently spans 17 polls
(~99k rows) but demographics was last fully rebuilt when only SPICE existed (1,421 rows), so
16 polls render blank demographic columns in the Sheet even though the live view resolves
~88.6%. Automation is needed so new responses reach the report without a hand-run.

This is a deliberate deviation from **ADR-0001**, which retired a standing `snowflake-new-row`
poller after it died silently for a month, and explicitly declined a periodic self-scan
backstop to avoid a standing scheduled job. Adding a scheduled enrichment job must therefore
be justified and the silent-death failure mode mitigated.

**Decision.** Run enrichment as **two Snowflake TASKs in a dependency DAG**, scheduled
nightly:

```
root TASK: resolve_identity        →  AFTER child TASK: enrich_demographics
(windowed EVENTS_412949 collapse)     (AA EMAIL MERGE, no-op when no new HEMs)
```

- **Mechanism: Snowflake TASK, not Pipedream.** The heavy work is *already* pure SQL, and it
  prunes well when scoped to recent polls (see Half A). A TASK runs it in-warehouse with **no
  300s lambda ceiling** (the manual runner allows snowsql up to 25 min for wide-window polls),
  no egress/VPC, and no JS runtime; the demographics half is a textbook pure-SQL `MERGE` with a
  native no-op guard. The cost is porting two small helpers out of `resolve-identity.js` into
  SQL — `computeEventWindow` (trivial `DATEADD` on `MIN/MAX(submitted_at) ± pad`) and
  `resolveHem` (precedence + HEM normalization, expressible as
  `CASE WHEN REGEXP_LIKE(LOWER(x),'^[0-9a-f]{64}$') …`) — which **retires `resolve-identity.js`
  and its 15 unit tests in favor of SQL assertion rows** (the `migration/assert_*.sql` pattern).
  This is a net simplification: it collapses what would otherwise be **two implementations** of
  the resolve logic (a JS runner for backfill + SQL for nightly, a drift risk) into **one SQL
  stored proc** parameterized by `poll_id`, called both by the nightly root TASK (set-based over
  recent polls) and for manual per-poll backfill.

- **Two TASKs in a DAG, not one combined proc.** The DAG makes ordering and dependency
  first-class: `enrich_demographics` runs **only after** `resolve_identity` succeeds — correct,
  because there are no new HEMs to enrich if identity didn't run, and you don't want demographics
  running on stale input if identity failed. The two halves also have distinct cost profiles and
  no-op conditions (windowed events scan vs the fixed AA scan), and map 1:1 to the follow-up
  issues — `resolve_identity` *is* #10, `enrich_demographics` *is* #9 — so each builds, tests,
  and reruns independently (e.g. `EXECUTE TASK enrich_demographics` alone for the one-time
  rebuild) while the DAG wires the ordering. A DAG is still monitored as a unit (one alert over
  its `TASK_HISTORY`), so "two objects" costs little.

- **Half A — `resolve_identity` (root), incremental and windowed.** Set-based over responses
  whose `INGESTION_ID` is not already in `DIM_RESPONDENT_IDENTITY` and whose poll has activity in
  the last **N days** (recency cushion; N=14, see below). Because all in-scope polls are recent,
  the combined `EVENT_TIME` filter on the `EVENTS_412949` join is a narrow recent range that
  prunes hard. Precedence + normalization stay in SQL (the seam, now SQL-side); idempotent
  per-poll `MERGE`/`DELETE+INSERT`. Polls past the window degrade gracefully — blank demographics,
  no error (story 22).

- **Half B — `enrich_demographics` (child), append-only with a cheap no-op.** `MERGE`/`INSERT`
  only the HEMs present in `DIM_RESPONDENT_IDENTITY` but absent from `DIM_RESPONDENT_DEMOGRAPHICS`.
  That set is a cheap dim-vs-dim check; when empty the TASK **skips the 497M-row AA scan entirely**.
  The AA scan cost is fixed regardless of HEM count (the random `SHA256` key can't prune the
  unclustered `EMAIL` table), so the only win is amortizing one scan across all new HEMs and
  skipping empty nights — which this delivers. **Semantic shift to note:** the table stops being a
  pure `SELECT *` mirror of the view and becomes an *accumulating* table — so if the view's
  deterministic-primary collapse logic ever changes, existing HEM rows will not pick it up;
  re-pulling then requires a manual full rebuild. Acceptable because the collapse logic is stable.

- **Schedule over handoff (the ADR-0001 reconciliation).** Identity recovery depends on a poll's
  raw events having *matured* — submitted, ingested into `EVENTS_412949`, and still in retention.
  A per-response handoff (the ADR-0001 default) would fire before the events are queryable; the
  timing is inherently time-based. A standing scheduled job is acceptable here because it is
  **idempotent** (per-poll MERGE for identity; append-only for demographics) and **observable** —
  failure alerting via a Snowflake `NOTIFICATION INTEGRATION` (email/SNS) or an `ALERT` over
  `TASK_HISTORY()`, so the ADR-0001 silent-death mode cannot recur unnoticed. This alerting is
  **load-bearing**, not optional.

**Retention constraint.** Identity recovery is only possible while a poll's events remain in
`EVENTS_412949`. The key point: **nightly + incremental resolution means each response is
resolved ~1 day after it arrives, while its events are ~1 day old — so retention essentially
never binds in steady state.** The exact retention horizon bounds only two secondary things: how
far a one-time historical backfill can reach, and how long the DAG can fail before responses
become permanently unresolvable (the reason alerting is load-bearing). That horizon is an
Amplitude project **config value** — **confirm with Chad Bruton**; it cannot be cheaply
reverse-engineered (`MIN(EVENT_TIME)` over the 55B-row table won't prune — scattered sentinel
timestamps force a full scan).

**Recency cushion N = 14 days.** N is *not* chasing the retention horizon (steady state doesn't
need it); it is a cushion for stragglers and missed/failed nights. 14 days covers that while
keeping the `EVENT_TIME` prune narrow. Revisit only if nightly outages routinely exceed it.

**Deployment.** The proc + two TASKs + notification integration are DDL in `migration/*.sql`,
deployed via snowsql — consistent with the existing DDL pattern, and not a Pipedream workflow
(no synced-workflow directory). Nothing here touches the GitHub→Pipedream sync.

**Deferred.** Scoping Half A by the new Braze catalog `enabled` flag (skip dead surveys) is a
clean future sharpening, but the flag is not yet synced into the dims (`flatten_catalog` doesn't
extract it; the dims have no column for it); the recency cushion covers the cost concern meanwhile.

**Rejected alternatives.**
- *Pipedream workflow(s)* — preserves the JS unit-test seam, but reintroduces the 300s lambda
  ceiling (fatal for wide-window backfill, where the runner allows 25 min), adds a JS runtime + a
  new REST-created workflow, and leaves a JS-for-backfill / SQL-for-nightly dual implementation.
- *Per-response explicit handoff (ADR-0001 style)* — fires before events have matured/ingested;
  identity would resolve against absent events and yield blanks.
- *Keep the manual runner* — the drift it produces (stale table, blank columns) is the problem.
- *One combined proc instead of a DAG* — conflates two concerns, can't rerun one half, and you'd
  hand-code the ordering the DAG gives for free.
- *Nightly full `CREATE OR REPLACE` rebuild* — a fixed ~150s AA scan every night regardless of
  change; the no-op guard makes empty nights free.

**Sequencing.** (1) **#10** — the `resolve_identity` SQL proc + root TASK (seam ported to SQL,
covered by assertions; retire `resolve-identity.js`). (2) **#9** — the `enrich_demographics`
child TASK with the cheap no-op. (3) Wire the DAG + notification integration; verify end-to-end:
a new response appears in the Sheet's demographics the morning after, no manual step, both
assertion scripts green. A one-time manual rebuild fixes today's stale table independently and
keeps reporting correct through the transition.
