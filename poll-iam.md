# Survey Definition — Authoring Reference

Authoritative spec for the survey blob consumed by `poll-iam.liquid` and submitted to the `survey-response-p_LQCoAMR` workflow. Written for agents that author new surveys; humans can read it too.

The renderer is the source of truth — when this doc and the renderer disagree, the renderer wins. If you spot drift, fix the doc.

---

## TL;DR for an authoring agent

A survey lives as a single row in the Braze `crm_prism_surveys` catalog. The row has three fields you author:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | The variant key. Must equal `definition.poll_id`. The IAM looks the row up by this. |
| `definition` | JSON string | The whole survey: pages, questions, options, conditionals, flags. |
| `intro_html` | string (Liquid) | Replaces the default header on page 1. Liquid is server-evaluated. |
| `outro_html` | string (Liquid) | Renders the "thanks" view. **Must contain `<div data-results-slot></div>`** where the percentage results land. |

When you ship a new survey you produce all three. The remainder of this doc is mostly about the JSON in `definition`.

---

## `definition` top-level shape

```jsonc
{
  "poll_id": "crm_<topic>_<year>_<variant?>",  // matches the catalog row id
  "version": 1,                                 // bump on breaking schema changes
  "title": "...",                               // shown in the default intro header
  "intro_subtitle": "...",                      // optional subtitle
  "theme":    { /* Theme, optional — see §Theme below */ },
  "pages":     [ /* Page, in display order */ ],
  "questions": { /* keyed map of Question */ }
}
```

---

## Theme

All fields are optional. Omitting `theme` entirely (or any individual key) falls back to the renderer defaults.

```jsonc
{
  "theme": {
    "accent": "#167ba5",               // --a1: buttons, selected borders, links
    "bg1":    "#fff",                  // --bg1: modal gradient top
    "bg2":    "#f6f8fb",               // --bg2: modal gradient bottom
    "card":   "#fff",                  // --card: question card background
    "text":   "#0f172a",              // --text: body copy
    "muted":  "rgba(15,23,42,0.68)",  // --muted: captions and sub-labels
    "border": "rgba(15,23,42,0.14)",  // --border: card/option borders

    "option_style": "spin"             // "spin" | "pulse" — animation on selection (omit = none)
  }
}
```

**`option_style` values:**
- `"spin"` — a small filled circle (matching the accent color) appears beside the option and spins once on selection.
- `"pulse"` — the entire option row does a quick scale-pop when selected.
- Omitted — no animation; `.selected` applies the tint only (existing behavior).

**Dark theme example:**
```json
"theme": {
  "accent": "#f59e0b",
  "bg1": "#1a1a2e",
  "bg2": "#16213e",
  "card": "#0f3460",
  "text": "#eaeaea",
  "muted": "rgba(234,234,234,0.55)",
  "border": "rgba(255,255,255,0.1)",
  "option_style": "spin"
}
```

Pages are an ordered array. Questions are a keyed map so a page can reference a question by key without duplicating its body. A question must be referenced by exactly one page (the renderer doesn't enforce this, but doing otherwise will confuse downstream tally).

---

## Pages

```jsonc
{
  "page_id": "snake_case_id",
  "title": "Optional page header (rendered on pages 2+; page 1 uses intro_html)",
  "show_if_user":   { /* UserPredicate, optional */ },
  "show_if_answer": { /* AnswerPredicate, optional */ },
  "groups": [
    { "questions": ["question_key_1", "question_key_2"] }
  ]
}
```

- `groups` is required and non-empty. Each group lists question keys to render together. Most pages use a single group; multi-group pages render in document order with no visual separator beyond the question card.
- A page is **skipped** at render time if any of its predicates evaluate false. Skipped pages don't count toward the "Submit on last page" check.
- The progress bar is hidden when `pages.length === 1`.

### Page navigation rules
- Page 1 renders `intro_html` (or a default header) above the questions; subsequent pages render `title` if present.
- The "Next" button becomes "Submit" when no later page is visible.
- "Back" appears only on `pageIndex > 0` (does not skip back over hidden pages — it walks the array linearly).

---

## Questions

Three types: `single`, `multi`, `text`. All share these fields:

```jsonc
{
  "type": "single" | "multi" | "text",
  "question": "Visible question text",
  "help_text": "Optional caption under the question",
  "required": true | false,         // default false
  "show_if_user":   { /* UserPredicate, optional */ },
  "show_if_answer": { /* AnswerPredicate, optional */ }
}
```

### `single` — one choice

```jsonc
{
  "type": "single",
  "question": "...",
  "required": true,
  "auto_advance": false,            // optional, default true. Set false to disable.
                                    // Auto-advances ~350ms after pick,
                                    // ONLY when this is the page's only visible question.
  "show_results": true,             // optional, default true. See "show_results" below.
  "options": [
    { "value": "Brazil", "description": "Five-time champions, back to defend?" },
    { "value": "Argentina" },
    { "value": "Prefer not to say", "is_catch_all": true }
  ]
}
```

The `value` is what gets stored, tallied, and joined to taxonomy downstream. Use Title Case display strings; consistency across surveys matters (always "Soccer", never "Football").

### `multi` — multiple choice

```jsonc
{
  "type": "multi",
  "question": "...",
  "required": true,
  "min_select": 1,                  // optional, default 1 when required
  "show_results": true,             // optional, default true
  "options": [
    { "value": "At home alone" },
    { "value": "Watch party with friends" },
    { "value": "I won't be watching", "is_catch_all": true }
  ]
}
```

The submitted answer is an **array** of selected `value` strings. The workflow tallies each option independently. `min_select` applies only when `required: true` (unrequired multis with zero selections are allowed).

### `text` — free response

```jsonc
{
  "type": "text",
  "question": "...",
  "help_text": "...",
  "max_length": 300,                // optional, default 500
  "required": false,
  "placeholder": "e.g. Mbappé in his prime"
}
```

- Text answers are **never tallied** — they don't appear in the percentage stats and `show_results` has no effect on them.
- Always show the user their own text back on the done view (this is automatic).
- `max_length` enforces both the textarea cap and the visible char counter.

---

## Options

```jsonc
{
  "value": "Brazil",                // required. The stored/tallied value.
  "label": "🇧🇷 Brazil",            // optional. Display override; defaults to value. May contain HTML.
  "description": "Five-time champions...",  // optional sub-line under the label
  "is_catch_all": true,             // optional. Marks "Other"/"Prefer not to say" type
                                    // options for downstream classifier to skip.
  "write_in": true,                 // optional. Reveals an inline text field when this option
                                    // is selected. The typed text replaces value in the payload.
  "write_in_placeholder": "..."     // optional. Placeholder for the write-in text field.
}
```

- `value` is the canonical key. Treat it as a stable identifier and don't change it post-launch — that breaks historical tallies and the taxonomy classifier's join.
- `label` is rendered as **trusted HTML** — you can include inline styles or `<span>` tags for visual styling (e.g. `<span style="color:#CE1141">Sixers</span>`). Use sparingly; keep it accessible. `value` remains plain text and must not contain HTML.
- `is_catch_all: true` does **not** change rendering. When the catalog sync writes this row to `DIM_SURVEY_CATALOG`, it sets `IS_CATCH_ALL = TRUE`, which the taxonomy classifier reads and passes to Claude as a `[catch-all]` marker, forcing an empty taxonomies result. Use it on "Other", "Prefer not to say", "None of these", "I won't be watching", etc.
  - On `multi` questions: selecting a catch-all option bypasses `min_select` — the catch-all stands alone.
- `write_in: true` turns the option into an "Other (please specify)" fallback. When selected, an inline text input appears; the typed text is submitted as the answer value instead of `value`. The write-in text is excluded from the tally cache (treated like a `text` question answer — lands in Snowflake and goes through the `text-response-classify` path). Pair with `is_catch_all: true` to prevent taxonomy classification on the sentinel value. At most one write-in option per question.

---

## Conditional logic

Two predicate kinds, attachable on either a page or a question.

### `show_if_answer` — depends on prior answer in this submission

```jsonc
{
  "question": "world_cup_pick",
  "op": "not_in",
  "values": ["Prefer not to say"]
}
```

Supported `op` values:

| op | shape of `values` | semantics |
|---|---|---|
| `equals` | scalar (note: still under the `values` key, not `value`) | answer === values |
| `in` | array | answer is one of values |
| `not_in` | array | answer is none of values |
| `is_set` | (ignored) | answer is not undefined / null / "" |
| `array_contains` | array | answer is an array AND at least one of `values` is in it |

Unknown ops return `true` (page/question shows). Don't rely on this — it's lenient by accident.

### `show_if_user` — depends on user's existing CRM profile

**Currently a stub.** `evalUserPredicate` returns `true` unconditionally — any page/question gated only on `show_if_user` is always shown. You may write the predicate (e.g. `{property: 'preference_insights', op: 'array_contains_prefix', values: ['Sports|Soccer']}`) for forward-compatibility, but don't depend on it filtering.

When implemented, the property dimension will read from values Amplitude has already pushed back to the IAM context (e.g. `consumption_insights`, `preference_insights`, demographic keys). Until then, treat `show_if_user` as documentation of intent.

---

## `show_results` flag

Per-question boolean on `single` / `multi` (no effect on `text`). Default `true`.

| Setting | Done-view behavior |
|---|---|
| `true` (default) | Question's option appears with the user's answer + tally percentage + bar |
| `false` | Question's answer appears, no percentage, no bar (same shape as text) |

The workflow always tallies regardless — `show_results` is a UI-only mute, so the data remains queryable in `STG_SURVEY_RESPONSES.RAW_DATA` and the `stats_<poll_id>` data store. Use it for sensitive or low-signal questions where the tally would be noise or feel intrusive.

---

## Render lifecycle

What is and isn't Liquid-evaluated matters for authoring:

| Field | Type | Liquid evaluated? | Notes |
|---|---|---|---|
| `definition` | JSON string | **No** | Plain JSON. `{{ }}` tokens here are NOT interpolated. |
| `intro_html` | HTML | **Yes** (via `:rerender` flag) | Personalization tokens like `{{ ${first_name} }}` work. Content blocks `{{content_blocks.${...}}}` work. **Recursive `{% catalog_items %}` does not work.** |
| `outro_html` | HTML | **Yes** | Same rules. Must contain `<div data-results-slot></div>` somewhere — the renderer injects per-question result cards into that slot. For `multi` questions, all selected answers are grouped under a single question header card rather than repeating the header per answer. |

Putting Liquid inside `definition` strings (e.g. `"question": "Hi {{${first_name}}} — ..."`) **does not work** — `definition` is parsed as JSON in the browser, not server-rendered.

To personalize a question, either:
1. Bake personalization into `intro_html` only and keep questions generic, or
2. Author multiple variants (segment-a / segment-b) of the row and let the Amplitude flag (`event_properties.${ampl_flag_key}`) route to the right one.

---

## Submit payload (what the workflow receives)

For reference — the renderer builds this on submit. Authors don't write it, but it's what lands in `STG_SURVEY_RESPONSES.RAW_DATA`:

```jsonc
{
  "poll_id": "prism_world_cup_2026_survey",
  "device_id": "<braze targeted_device id>",
  "external_id": "<braze user_id>",       // empty for anonymous users
  "market_name": "<paper code>",          // from event_properties.market_name
  "variant": "<flag value>",              // the Amplitude flag value used to look up the row
  "submitted_at": "ISO8601",
  "answers": [
    { "question": "world_cup_pick",       "answer": "Brazil",                 "type": "single" },
    { "question": "watch_methods",        "answer": ["At home alone","..."],  "type": "multi" },
    { "question": "favorite_player_text", "answer": "Mbappé...",              "type": "text" }
  ],
  "client_ip": "<server-captured>"
}
```

Things the workflow does that affect authoring:
- **Tallies are cached** in a Pipedream data store keyed by `poll_id`. The cache survives across submissions and is what powers the inline percentage in the response.
- **Free-text and `show_results: false` are still inserted into Snowflake.** They're suppressed from the **rendered** done view, not from the data.
- **Missing answers are dropped** at submit time — the renderer only sends `state.answers` keys that exist in `SURVEY.questions`.
- **Answers for hidden questions are cleared immediately** when a gating answer changes. If a user answers "Yes" → selects options on a gated page → goes back and changes to "No", the gated page's answers are wiped from state at the moment of the change — they do not appear on the done view or in the payload.

---

## Braze click tracking

The renderer fires `brazeBridge.logClick` at two points:

| Event | When | Button ID |
|---|---|---|
| `Q1`, `Q2`, … `Qn` | User advances past page `n` (Next / auto-advance / Submit on the last question page). Fires **at most once per page per session** — back-and-forth does not re-fire. | Page index, 1-based |
| `Submit` | Survey submitted (after the last page is completed). | `Submit` |

Use these as a funnel in Braze: `Q1` impressions → `Q2` completions → … → `Submit` shows drop-off at each step. No click is fired for the Close button.

---

## Conventions

- **`poll_id`**: `crm_<topic>_<year>` for shared rows; suffix `_segment_a` / `_segment_b` for variants.
- **Question keys**: snake_case, descriptive, no spaces (`world_cup_pick`, not `wcp` or `world cup pick`).
- **Option `value`**: Title Case display strings ("Brazil", "Watch party with friends"). Reuse exact strings across surveys for the same concept — the taxonomy classifier joins on them.
- **`is_catch_all: true`** on every "Other" / "Prefer not to say" / "I won't be watching" type option. Critical for clean downstream taxonomy.
- **`show_results: false`** on questions that would feel intrusive to surface back (political affiliation, income, anything sensitive). Default-true otherwise.
- **`required: true`** on questions that gate the entire poll's value. Avoid making everything required — completion rate matters.
- **`auto_advance: false`** to disable on single-question pages where auto-advancing would feel abrupt (e.g. sensitive questions). Default is true — no need to set it explicitly to enable it.

---

## Worked example

`test-survey-definition.json` and `test-survey-templates.html` in this repo are the canonical worked example — three pages, all three question types, both predicate kinds, `show_results: false` on a sensitive question, `is_catch_all` on the obvious options, the `outro_html` results-slot pattern. Treat them as the live "hello world."

---

## Known gaps / not-yet-implemented

| Feature | Status | Notes |
|---|---|---|
| `show_if_user` predicates | **Stub** | Always evaluates true. Author for documentation; don't depend on it filtering. |
| `array_contains_prefix` op | **Not implemented** | Falls through default `true`. Useful for `Sports\|Soccer` style prefix matches once user predicates are wired. |
| Per-option `show_results` | Not planned | Granularity is per-question only. |
| `back` skipping over hidden pages | Walks linearly; hidden pages are still touched | Low-impact since hidden pages have no questions to display. |
| `version` enforcement | None | Bump it on schema changes; no runtime check yet. |
| Multi-line text answers / file uploads / matrix questions | Out of scope | The three current types are the contract. |

When you implement one of these, update this doc in the same change.
