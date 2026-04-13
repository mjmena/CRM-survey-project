export default defineComponent({
  name: "Flatten Catalog",
  description: "Parses JSON question definitions from catalog items into flat rows for Snowflake",
  props: {
    catalog_items: {
      type: "any",
      label: "Catalog Items",
      description: "Array of catalog items from Braze",
    },
  },
  async run({ $ }) {
    const items = this.catalog_items || [];
    const rows = [];

    for (const item of items) {
      const pollId = item.id;
      if (!pollId) continue;

      // Question definitions are in columns "1" through "10"
      for (let col = 1; col <= 10; col++) {
        const raw = item[String(col)];
        if (!raw) continue;

        let def;
        try {
          def = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          continue;
        }

        // Extract question key and text from either format
        // Format A: {id, prompt, options: [{value, label}]}
        // Format B: {question_key, question, options: [{value, description}]}
        const questionKey = def.id || def.question_key;
        const questionText = def.prompt || def.question || "";
        const options = def.options || [];

        if (!questionKey || options.length === 0) continue;

        for (const opt of options) {
          // For label: use explicit label if present, otherwise value IS the display text
          const optionValue = opt.value || "";
          const optionLabel = opt.label || opt.value || "";

          rows.push({
            poll_id: pollId,
            question_key: questionKey,
            question_text: questionText,
            option_value: optionValue,
            option_label: optionLabel,
          });
        }
      }
    }

    $.export("$summary", `Flattened ${items.length} catalog items into ${rows.length} rows`);
    return {
      rows,
      rows_json: JSON.stringify(rows),
    };
  },
});
