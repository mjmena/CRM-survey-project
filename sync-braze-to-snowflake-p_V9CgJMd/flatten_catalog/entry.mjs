export default defineComponent({
  name: "Flatten Catalog",
  description:
    "Parses survey definitions from Braze catalog items into questions[] and options[] for Snowflake upsert.",
  props: {
    catalog_items: {
      type: "any",
      label: "Catalog Items",
      description: "Array of catalog items from Braze crm_prism_surveys",
    },
  },
  async run({ $ }) {
    const items = this.catalog_items || [];
    const questions = [];
    const options = [];

    for (const item of items) {
      const pollId = item.id;
      if (!pollId) continue;

      if (item.definition) {
        let def;
        try {
          def = typeof item.definition === "string" ? JSON.parse(item.definition) : item.definition;
          if (typeof def === "string") def = JSON.parse(def);
        } catch (err) {
          console.warn(`Skipping item ${pollId}: definition parse failed — ${err.message}`);
          continue;
        }

        const definitionVersion = def.version ?? null;
        const questionMap = def.questions || {};

        for (const [questionKey, q] of Object.entries(questionMap)) {
          const qType = q.type || "single";

          questions.push({
            poll_id: pollId,
            question_key: questionKey,
            question_type: qType,
            question_text: q.question || null,
            help_text: q.help_text || null,
            is_required: q.required === true,
            min_select: q.min_select ?? null,
            max_length: q.max_length ?? null,
            placeholder: q.placeholder || null,
            show_results: q.show_results !== false,
            auto_advance: q.auto_advance ?? null,
            definition_version: definitionVersion,
          });

          if (qType !== "text") {
            const optList = q.options || [];
            for (let i = 0; i < optList.length; i++) {
              const opt = optList[i];
              const val = opt.value || "";
              const lbl = opt.label && opt.label !== val ? opt.label : null;
              options.push({
                poll_id: pollId,
                question_key: questionKey,
                option_value: val,
                option_label: lbl,
                option_description: opt.description || null,
                is_catch_all: opt.is_catch_all === true,
                sort_order: i,
              });
            }
          }
        }
      } else {
        // Legacy format: numbered columns "1" through "10"
        for (let col = 1; col <= 10; col++) {
          const raw = item[String(col)];
          if (!raw) continue;

          let def;
          try {
            def = typeof raw === "string" ? JSON.parse(raw) : raw;
          } catch (err) {
            console.warn(`Skipping ${pollId} col ${col}: parse failed — ${err.message}`);
            continue;
          }

          const questionKey = def.id || def.question_key;
          const questionText = def.prompt || def.question || null;
          const optList = def.options || [];
          if (!questionKey || optList.length === 0) continue;

          questions.push({
            poll_id: pollId,
            question_key: questionKey,
            question_type: "single",
            question_text: questionText,
            help_text: null,
            is_required: null,
            min_select: null,
            max_length: null,
            placeholder: null,
            show_results: true,
            auto_advance: null,
            definition_version: null,
          });

          for (let i = 0; i < optList.length; i++) {
            const opt = optList[i];
            const val = opt.value || "";
            const lbl = opt.label && opt.label !== val ? opt.label : null;
            options.push({
              poll_id: pollId,
              question_key: questionKey,
              option_value: val,
              option_label: lbl,
              option_description: null,
              is_catch_all: false,
              sort_order: i,
            });
          }
        }
      }
    }

    $.export(
      "$summary",
      `Flattened ${items.length} catalog items: ${questions.length} questions, ${options.length} options`
    );
    return {
      questions,
      questions_json: JSON.stringify(questions),
      options,
      options_json: JSON.stringify(options),
    };
  },
});
