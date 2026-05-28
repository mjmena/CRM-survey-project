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

## Flagged ambiguities

- **"Content block"** is ambiguous: both the Insights Hub page and the Poll widget are Braze
  content blocks. Default reading in this project: the **Poll widget**
  (`prism_template_for_landingpage.html`). Say "the Hub" / "the Hub page" for the other.
- **`crm_prism_surveys`** (catalog name) backs **Polls**, not Premium Surveys, despite the
  "surveys" name. Premium Surveys are in `crm_prism_external_surveys`.
