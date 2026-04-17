export default defineComponent({
  name: "Skip If Classified",
  description:
    "Exits the workflow early if the triggered poll has already been classified.",
  props: {
    build_result: {
      type: "any",
      label: "Check Result",
      description: "Object with poll_id and already_classified count",
    },
  },
  async run({ $ }) {
    const pollId = this.build_result?.poll_id;
    const count = Number(this.build_result?.already_classified || 0);

    if (count > 0) {
      $.flow.exit(`Poll "${pollId}" already has ${count} taxonomy rows — skipping`);
    }

    $.export("$summary", `Poll "${pollId}" is new — proceeding with classification`);
    return { poll_id: pollId };
  },
});
