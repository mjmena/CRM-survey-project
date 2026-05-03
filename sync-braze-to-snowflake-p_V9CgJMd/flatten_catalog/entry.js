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

      if (item.definition) {
        // v2 format: single `definition` blob with the full survey JSON
        let def;
        try {
          def = typeof item.definition === "string" ? JSON.parse(item.definition) : item.definition;
          if (typeof def === "string") def = JSON.parse(def); // handle double-encoded
        } catch {
          continue;
        }

        const questions = def.questions || {};
        for (const [questionKey, q] of Object.entries(questions)) {
          const questionText = q.question || "";
          const options = q.options || [];
          for (const opt of options) {
            rows.push({
              poll_id: pollId,
              question_key: questionKey,
              question_text: questionText,
              option_value: opt.value || "",
              option_label: opt.label || opt.value || "",
              is_catch_all: opt.is_catch_all === true,
            });
          }
        }
      } else {
        // Legacy format: question definitions in columns "1" through "10"
        for (let col = 1; col <= 10; col++) {
          const raw = item[String(col)];
          if (!raw) continue;

          let def;
          try {
            def = typeof raw === "string" ? JSON.parse(raw) : raw;
          } catch {
            continue;
          }

          // Format A: {id, prompt, options: [{value, label}]}
          // Format B: {question_key, question, options: [{value, description}]}
          const questionKey = def.id || def.question_key;
          const questionText = def.prompt || def.question || "";
          const options = def.options || [];

          if (!questionKey || options.length === 0) continue;

          for (const opt of options) {
            rows.push({
              poll_id: pollId,
              question_key: questionKey,
              question_text: questionText,
              option_value: opt.value || "",
              option_label: opt.label || opt.value || "",
              is_catch_all: false,
            });
          }
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
