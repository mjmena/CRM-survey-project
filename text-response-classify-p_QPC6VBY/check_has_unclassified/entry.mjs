export default defineComponent({
  name: "Check Has Unclassified",
  description: "Exits early if there are no unclassified text responses to process.",
  props: {
    text_options: {
      type: "any",
      label: "Text Options",
      description: "Unclassified rows from DIM_SURVEY_OPTIONS where OPTION_SOURCE='response'",
    },
  },
  async run({ $ }) {
    const opts = this.text_options || [];
    if (opts.length === 0) {
      $.flow.exit("No unclassified text responses — skipping classification");
    }
    $.export("$summary", `Found ${opts.length} unclassified text responses to classify`);
    return { count: opts.length };
  },
});
