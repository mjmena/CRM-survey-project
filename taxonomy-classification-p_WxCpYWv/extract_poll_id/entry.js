export default defineComponent({
  name: "Extract Poll ID",
  description:
    "Extracts POLL_ID from the trigger event, handling both HTTP and Snowflake new row trigger formats.",
  props: {
    trigger_event: {
      type: "any",
      label: "Trigger Event",
      description: "The raw trigger event object",
    },
  },
  async run({ $ }) {
    const event = this.trigger_event || {};

    // HTTP trigger: event.body.POLL_ID
    // Snowflake new row trigger: event.POLL_ID
    const pollId = event.body?.POLL_ID || event.POLL_ID;

    if (!pollId) {
      $.flow.exit(
        "No POLL_ID found in trigger event. Expected event.body.POLL_ID (HTTP) or event.POLL_ID (Snowflake)."
      );
    }

    $.export("$summary", `Processing poll: ${pollId}`);
    return { poll_id: pollId };
  },
});
