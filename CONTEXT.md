# PRISM Survey Hub — Context

The reader-facing surfaces of the PRISM survey pipeline: the Braze landing page where
readers answer surveys/polls, and the Braze content blocks and catalogs that feed it.
(The classification/Snowflake/Amplitude side is documented in CLAUDE.md and README.md.)

## Language

**Insights Hub**:
The reader-facing Braze landing page that lists surveys and polls for a reader to answer.
The visible page name is "Insights Hub" (renamed from the legacy "Survey Hub").
File: `prism-landingpage.html`.
_Avoid_: Survey Hub (legacy title), landing page (too generic when the Hub specifically is meant)

**Poll**:
A short, single- or few-question survey that opens and is answered **inline** on the Insights
Hub. Backed by the `crm_prism_surveys` catalog. Rendered by the poll widget content block.
Shown under the "Quick Polls" / "Featured Quick Polls" sections.

**Premium Survey**:
A longer survey that lives on an **external** page; its Hub card is just a link out
(`Take Survey →`). Backed by the `crm_prism_external_surveys` catalog. Shown under the
"Premium Surveys" / "Featured Premium Surveys" sections.
_Avoid_: calling these "polls" — Polls are inline, Premium Surveys link out.

**Poll widget**:
The embedded Braze content block that renders a single Poll inline (intro → questions →
results). File: `prism_template_for_landingpage.html`; referenced on the Hub as
`{{content_blocks.${prism_template_for_landingpage}}}`. Has its own `.prism-poll` styling,
separate from the Hub's `.survey-card` design system. The landing-page sibling of the
IAM poll content block (`poll-iam.html`).
_Avoid_: "the content block" unqualified (the Hub page is also a content block).

**Survey card**:
The Hub's outer card chrome (`.survey-card`) that wraps each Poll or Premium Survey in the
grid. Distinct from the Poll widget that renders *inside* an opened Poll card.

## Classification lifecycle

**Classifying** (a.k.a. _producing_):
Claude turning a survey answer option into one or more `DIM_SURVEY_TAXONOMY` rows
(bucket + path/key-value + confidence). Done by the `taxonomy-classification` and
`text-response-classify` workflows. Rows land with `IS_APPROVED = FALSE`.

**Surfacing** (a.k.a. _communicating_ a new taxonomy):
Presenting freshly-classified taxonomy rows to a human to review and approve
(`IS_APPROVED → TRUE`) before they flow downstream to Amplitude. **Not yet built** —
this is the missing step the team refers to when it says taxonomies aren't being
"communicated." Distinct from _classifying_, which is the upstream producing step.
_Avoid_: using "communicating" to mean the classifying/producing step.

**Approved** (`IS_APPROVED`):
A boolean on `DIM_SURVEY_TAXONOMY` intended to mark a classification as human-reviewed.
**Currently decorative** — `V_AMPLITUDE_SURVEY_SYNC` does not filter on it, so every
classification flows to Amplitude regardless. A real approval gate requires both the
_surfacing_ step (to set it) and a `WHERE IS_APPROVED` in the sync view (to enforce it).

## Flagged ambiguities

- **"Content block"** is ambiguous: both the Insights Hub page and the Poll widget are Braze
  content blocks. Default reading in this project: the **Poll widget**
  (`prism_template_for_landingpage.html`). Say "the Hub" / "the Hub page" for the other.
- **`crm_prism_surveys`** (catalog name) backs **Polls**, not Premium Surveys, despite the
  "surveys" name. Premium Surveys are in `crm_prism_external_surveys`.
- **`crm_surveys`** (no `prism_`) is the **retired** legacy Poll catalog. Going forward only
  `crm_prism_surveys` is authored and synced; `sync-braze-to-snowflake` reads
  `crm_prism_surveys`. Legacy `sf-*` polls may be migrated over later.
  _Avoid_: treating `crm_surveys` as current.
