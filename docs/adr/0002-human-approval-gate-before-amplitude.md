# Human approval gate before taxonomies reach Amplitude

**Context.** Claude-generated classifications in `DIM_SURVEY_TAXONOMY` carry an
`IS_APPROVED` boolean, but it is currently decorative: `V_AMPLITUDE_SURVEY_SYNC` does
not filter on it, so every classification (approved or not) flows to Amplitude and on to
Braze segmentation. A low-confidence or wrong classification reaches user-facing
segmentation with no human in the loop.

**Decision.** The intended end-state is **gated**: a classification must be
human-approved before it reaches Amplitude. This requires two pieces that do not yet
exist together — a *surfacing* step that lets a human review and set `IS_APPROVED`, and a
`WHERE t.IS_APPROVED` filter in `V_AMPLITUDE_SURVEY_SYNC` that enforces it.

**Sequencing (deliberate).** The gate is a **separate milestone**, not part of restoring
producing. Order:
1. Restore producing (explicit handoff, see ADR-0001) and backfill the unclassified
   polls — view stays **ungated** so the pipeline is end-to-end live.
2. Build the surfacing/review surface (the `prism-mcp` connector already exposes
   `get_taxonomy`; add an approve capability).
3. Bulk-approve the existing backlog, then add `WHERE IS_APPROVED` to the view and flip
   to gated — a single reversible change.

Flipping the gate before step 3 would instantly cut the Amplitude feed from ~95k rows to
the handful currently approved, so the ordering is load-bearing.
