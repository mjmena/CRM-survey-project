export default defineComponent({
  name: "Build Prompt",
  description:
    "Builds system and user prompts from catalog data and existing taxonomies for Claude classification.",
  props: {
    catalog_rows: {
      type: "any",
      label: "Catalog Rows",
      description: "Array of catalog rows from Snowflake DIM_SURVEY_CATALOG",
    },
    existing_taxonomies: {
      type: "any",
      label: "Existing Taxonomies",
      description:
        "Array of existing taxonomy rows from DIM_SURVEY_TAXONOMY (can be empty)",
    },
  },
  async run({ $ }) {
    const catalogRows = this.catalog_rows || [];
    const existingTaxonomies = this.existing_taxonomies || [];

    if (catalogRows.length === 0) {
      $.export("$summary", "No catalog rows to classify");
      return { system_prompt: "", user_message: "", poll_count: 0, row_count: 0 };
    }

    // ---------------------------------------------------------------
    // System prompt
    // ---------------------------------------------------------------
    const system_prompt = `You are a taxonomy classification engine for a CRM survey system.

You assign each survey answer option to one or more classifications. There are three buckets with DIFFERENT output formats:

## Bucket definitions

1. **consumption** — what they BUY or USE (purchasing behavior, spending priorities, investments, products, wellness products)
   Output: pipe-delimited taxonomy string in Title Case
   Examples: "Real Estate|Home Renovation", "Wellness|Supplements", "Travel|International Adventures"

2. **preference** — what they LIKE or WANT (sports teams, food, travel style, entertainment, content format, attitudes)
   Output: pipe-delimited taxonomy string in Title Case
   Examples: "Sports|Soccer|World Cup 2026|Brazil", "Food & Drink|Holiday Beverages|Hot Chocolate", "Politics|Engagement|Undecided"

3. **demographic** — fact-based attributes about who the person IS (life stage, political affiliation, voting status)
   Output: explicit key/value pair with a type
   Examples: {"demographic_key": "political_affiliation", "demographic_value": "Democrat", "demographic_type": "string"}
            {"demographic_key": "retired", "demographic_value": "true", "demographic_type": "boolean"}

## Rules for consumption and preference (taxonomy strings)

- Use Title Case with natural spacing: "Sports|Basketball|March Madness 2026|Duke Blue Devils" NOT "sports|basketball|march_madness_2026|duke_blue_devils"
- Pipe | is the delimiter between hierarchy levels
- Variable depth (typically 2-4 levels)
- The taxonomy string does NOT include the bucket name
- Use readable, polished words — these will appear directly in Amplitude and Braze UIs

## Rules for demographic (key/value)

- demographic_key: lowercase_snake_case identifier (e.g., "political_affiliation", "retired", "retirement_prepared")
- demographic_value: the actual value as a string (e.g., "Democrat", "true", "College")
- demographic_type: one of "string", "boolean", "number"
- For boolean values, use "true" or "false" as strings in demographic_value

## General rules

- Use the ENTIRE POLL as context. The poll topic, question wording, and all answer options together should inform each classification.
- **Concrete only**: Only classify what the user EXPLICITLY stated. Do NOT infer attributes the user did not directly express. If someone picks "Lakers", that means they prefer the Lakers — it does NOT mean they live in LA or are male.
- An answer CAN have multiple classifications (e.g., one "preference" and one "consumption"). Only assign multiple when genuinely warranted.
- Options explicitly marked **[catch-all]** in the list below MUST return an empty `taxonomies` array — no exceptions. These are options like "Prefer not to say", "Other", "Something Else", or "I won't be watching" that the survey author flagged as non-informative. Do not attempt to classify them.
- Be consistent: the same concept should always use the same taxonomy segment.
- For segment variants of the same poll (e.g., segment-a, segment-b), use identical classifications.

## Response format

Return a JSON array. Each element:
{
  "poll_id": string,
  "question_key": string,
  "option_value": string,
  "taxonomies": [
    // For consumption or preference:
    {"bucket": "consumption"|"preference", "taxonomy_path": string, "confidence": float 0-1}
    // For demographic:
    {"bucket": "demographic", "demographic_key": string, "demographic_value": string, "demographic_type": "string"|"boolean"|"number", "confidence": float 0-1}
  ]
}

Return ONLY the JSON array, no markdown fencing or extra text.`;

    // ---------------------------------------------------------------
    // Build existing taxonomy reference
    // ---------------------------------------------------------------
    let existingRef = "";
    if (existingTaxonomies.length > 0) {
      const prefPaths = new Set();
      const consPaths = new Set();
      const demoKeys = new Set();

      for (const t of existingTaxonomies) {
        const b = (t.BUCKET || "").toLowerCase();
        if (b === "preference" && t.TAXONOMY_PATH) prefPaths.add(t.TAXONOMY_PATH);
        if (b === "consumption" && t.TAXONOMY_PATH) consPaths.add(t.TAXONOMY_PATH);
        if (b === "demographic" && t.DEMOGRAPHIC_KEY) demoKeys.add(t.DEMOGRAPHIC_KEY);
      }

      const sections = [];
      if (consPaths.size > 0) {
        sections.push(`consumption taxonomy paths:\n${[...consPaths].sort().map((p) => `  - ${p}`).join("\n")}`);
      }
      if (prefPaths.size > 0) {
        sections.push(`preference taxonomy paths:\n${[...prefPaths].sort().map((p) => `  - ${p}`).join("\n")}`);
      }
      if (demoKeys.size > 0) {
        sections.push(`demographic keys:\n${[...demoKeys].sort().map((k) => `  - ${k}`).join("\n")}`);
      }

      if (sections.length > 0) {
        existingRef = `Here are the classifications already in use. Reuse these taxonomy paths and demographic keys wherever applicable. Do not create duplicates.\n\n${sections.join("\n\n")}\n\n---\n\n`;
      }
    }

    // ---------------------------------------------------------------
    // Group catalog rows by poll_id and build per-poll blocks
    // ---------------------------------------------------------------
    const polls = new Map();
    for (const row of catalogRows) {
      const pid = row.POLL_ID;
      if (!polls.has(pid)) polls.set(pid, []);
      polls.get(pid).push(row);
    }

    const pollBlocks = [];
    for (const [pollId, rows] of polls) {
      const questions = new Map();
      for (const r of rows) {
        const qk = r.QUESTION_KEY;
        if (!questions.has(qk)) {
          questions.set(qk, { text: r.QUESTION_TEXT, options: [] });
        }
        questions.get(qk).options.push({
          value: r.OPTION_VALUE,
          label: r.OPTION_LABEL,
          is_catch_all: r.IS_CATCH_ALL === true,
        });
      }

      let block = `Survey: ${pollId}\n`;
      let qNum = 1;
      for (const [qKey, qData] of questions) {
        const qText = qData.text?.trim()
          ? `"${qData.text.trim()}"`
          : "(no question text — infer from poll context and answer options)";
        block += `  Q${qNum} [${qKey}]: ${qText}\n`;
        block += `    Options:\n`;
        for (const opt of qData.options) {
          const label = opt.label !== opt.value ? ` (${opt.label})` : "";
          const catchAllMarker = opt.is_catch_all ? " [catch-all]" : "";
          block += `      - ${opt.value}${label}${catchAllMarker}\n`;
        }
        qNum++;
      }
      pollBlocks.push(block);
    }

    const user_message = `${existingRef}Classify each answer option in the following surveys.\n\n${pollBlocks.join("\n")}`;

    // Combine system + user into a single message for the built-in
    // anthropic-chat action which lacks a separate system_prompt prop
    const combined_message = `<instructions>\n${system_prompt}\n</instructions>\n\n${user_message}`;

    $.export(
      "$summary",
      `Built prompts for ${catalogRows.length} options across ${polls.size} polls`
    );

    return {
      system_prompt,
      user_message,
      combined_message,
      poll_count: polls.size,
      row_count: catalogRows.length,
    };
  },
});
