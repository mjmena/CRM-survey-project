export default defineComponent({
  name: "Build Text Prompt",
  description:
    "Builds a Claude prompt to classify free-text survey responses into taxonomy. Uses the same classification rules and output format as catalog option classification.",
  props: {
    text_options: {
      type: "any",
      label: "Text Options",
      description: "Unclassified rows from DIM_SURVEY_OPTIONS where OPTION_SOURCE='response'",
    },
    existing_taxonomies: {
      type: "any",
      label: "Existing Taxonomies",
      description: "Existing taxonomy rows from DIM_SURVEY_TAXONOMY for consistency",
    },
  },
  async run({ $ }) {
    const rows = this.text_options || [];
    const existingTaxonomies = this.existing_taxonomies || [];

    if (rows.length === 0) {
      return { combined_message: "", row_count: 0 };
    }

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

- These are FREE-TEXT responses typed by survey respondents. Classify them exactly as you would classify predefined answer options.
- Use the ENTIRE POLL as context. The poll topic, question wording, and all responses together should inform each classification.
- **Concrete only**: Only classify what the user EXPLICITLY stated. Do NOT infer attributes the user did not directly express.
- An answer CAN have multiple classifications (e.g., one "preference" and one "consumption"). Only assign multiple when genuinely warranted.
- If a free-text response is uninformative, spam, or meaningless (e.g., "n/a", "test", "123", single letters), return an empty \`taxonomies\` array.
- Be consistent: the same concept should always use the same taxonomy segment.
- In the output JSON, set "option_value" to the EXACT text shown as the response (do not alter it).

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

    // Build existing taxonomy reference
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

    // Group responses by poll + question
    const polls = new Map();
    for (const row of rows) {
      const pid = row.POLL_ID;
      const qk = row.QUESTION_KEY;
      if (!polls.has(pid)) polls.set(pid, new Map());
      if (!polls.get(pid).has(qk)) {
        polls.get(pid).set(qk, { text: row.QUESTION_TEXT, responses: [] });
      }
      polls.get(pid).get(qk).responses.push(row.OPTION_VALUE);
    }

    const pollBlocks = [];
    for (const [pollId, questions] of polls) {
      let block = `Survey: ${pollId}\n`;
      let qNum = 1;
      for (const [qKey, qData] of questions) {
        const qText = qData.text?.trim()
          ? `"${qData.text.trim()}"`
          : "(no question text — infer from poll context and responses)";
        block += `  Q${qNum} [${qKey}]: ${qText} (free-text question)\n`;
        block += `    Responses to classify:\n`;
        for (const response of qData.responses) {
          block += `      - ${response}\n`;
        }
        qNum++;
      }
      pollBlocks.push(block);
    }

    const user_message = `${existingRef}Classify each free-text response below. Treat each response as if it were a predefined answer option.\n\n${pollBlocks.join("\n")}`;

    const combined_message = `<instructions>\n${system_prompt}\n</instructions>\n\n${user_message}`;

    $.export("$summary", `Built text prompt for ${rows.length} responses across ${polls.size} polls`);
    return { combined_message, row_count: rows.length };
  },
});
