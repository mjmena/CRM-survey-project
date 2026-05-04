export default defineComponent({
  name: "Skip If Classified",
  description:
    "Exits early if the poll is already classified or has no single/multi questions.",
  props: {
    build_result: {
      type: "any",
      label: "Check Result",
      description: "Object with poll_id, already_classified count, and classifiable_cnt",
    },
  },
  async run({ $ }) {
    const pollId = this.build_result?.poll_id;
    const count = Number(this.build_result?.already_classified || 0);
    const classifiable = Number(this.build_result?.classifiable_cnt ?? -1);

    if (count > 0) {
      $.flow.exit(`Poll "${pollId}" already has ${count} taxonomy rows — skipping`);
    }
    if (classifiable === 0) {
      $.flow.exit(`Poll "${pollId}" has no single/multi questions — skipping`);
    }

    $.export("$summary", `Poll "${pollId}" is new — proceeding with classification`);
    return { poll_id: pollId };
  },
});
