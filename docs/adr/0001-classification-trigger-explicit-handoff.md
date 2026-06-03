# Trigger taxonomy classification by explicit handoff from the catalog sync

**Context.** Taxonomy classification was triggered by a Pipedream `snowflake-new-row`
source (`dc_kjuLB8b`). Verified facts: the source was *active*, watching the correct live
table `DIM_SURVEY_QUESTIONS`, on a 15-min timer, with its `uniqueKey` (dedup column) set
to `POLL_ID`. It emitted **no events after ~2026-05-02**, and every poll created after the
2026-05-04 backfill went unclassified — classification produced nothing for a month and
no one was alerted. The probable cause is that `POLL_ID` — a non-monotonic, non-unique
string (a poll name), with one row per question — is an unfit key for new-row detection:
under a high-water-mark model it stalls once the lexical maximum is seen, and the missing
polls do all sort below the lexical-max classified poll (`sf-generation-trust-flip-poll`).
The exact failure mode was not confirmed against the component internals, and is moot for
the decision below — `POLL_ID` is an unsuitable trigger key either way.

**Decision.** Retire the `snowflake-new-row` source. Instead, `sync-braze-to-snowflake`
POSTs each newly-synced `poll_id` to the classification workflow's existing HTTP trigger
(`hi_VOHV2Qx`) after the catalog upsert. Producing becomes a deterministic step of the
sync rather than a separate poller that can silently die. `extract_poll_id` already
accepts the HTTP shape (`event.body.POLL_ID`).

**Rejected alternatives.**
- *Repoint the `snowflake-new-row` source at a live table* — keeps the same trap; any
  non-monotonic watermark key reproduces the silent freeze.
- *Periodic self-scan backstop* (a timer that classifies polls lacking taxonomy rows) —
  declined to avoid a standing scheduled job. The existing backlog is drained by a
  one-time manual backfill instead.
