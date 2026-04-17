export default defineComponent({
  name: "Flatten Results",
  description:
    "Flattens AI classification results into rows for Snowflake upsert. Handles both taxonomy paths (consumption/preference) and demographic key/value pairs.",
  props: {
    ai_results: {
      type: "any",
      label: "AI Results",
      description: "Classification results from the classify_with_ai step",
    },
  },
  async run({ $ }) {
    const results = this.ai_results?.results || [];
    const rows = [];

    for (const item of results) {
      if (!item.taxonomies || item.taxonomies.length === 0) continue;

      for (const t of item.taxonomies) {
        const bucket = t.bucket;

        if (bucket === "demographic") {
          // Demographic: key/value pair
          if (!t.demographic_key) continue;
          rows.push({
            poll_id: item.poll_id,
            question_key: item.question_key,
            option_value: item.option_value,
            bucket,
            taxonomy_path: null,
            taxonomy_depth: null,
            taxonomy_levels: null,
            demographic_key: t.demographic_key,
            demographic_value: t.demographic_value,
            demographic_type: t.demographic_type,
            confidence: t.confidence,
          });
        } else {
          // Consumption or Preference: taxonomy path
          if (!t.taxonomy_path) continue;
          const levels = t.taxonomy_path.split("|");
          rows.push({
            poll_id: item.poll_id,
            question_key: item.question_key,
            option_value: item.option_value,
            bucket,
            taxonomy_path: t.taxonomy_path,
            taxonomy_depth: levels.length,
            taxonomy_levels: levels,
            demographic_key: null,
            demographic_value: null,
            demographic_type: null,
            confidence: t.confidence,
          });
        }
      }
    }

    const skipped = results.filter(
      (r) => !r.taxonomies || r.taxonomies.length === 0
    ).length;

    const bucketCounts = {};
    for (const r of rows) {
      bucketCounts[r.bucket] = (bucketCounts[r.bucket] || 0) + 1;
    }

    $.export(
      "$summary",
      `Flattened to ${rows.length} taxonomy rows (${skipped} answers skipped). Buckets: ${Object.entries(bucketCounts).map(([b, c]) => `${b}=${c}`).join(", ")}`
    );

    return {
      rows,
      rows_json: JSON.stringify(rows),
    };
  },
});
