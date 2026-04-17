export default defineComponent({
  name: "Check New Polls",
  description:
    "Exits the workflow early if there are no new polls to classify.",
  props: {
    build_result: {
      type: "any",
      label: "Build Result",
      description: "Return value from the build_prompt step",
    },
  },
  async run({ $ }) {
    if (!this.build_result?.row_count) {
      $.flow.exit("No new polls to classify");
    }
    $.export(
      "$summary",
      `${this.build_result.row_count} options across ${this.build_result.poll_count} new poll(s) to classify`
    );
    return this.build_result;
  },
});
