export default defineComponent({
  name: "Extract Params",
  description:
    "Extracts poll_id + spreadsheet_id from the HTTP trigger event (the orchestrator's {poll_id, spreadsheet_id} handoff). Handles both event.body.* (HTTP) and top-level event.* (manual test) shapes, à la taxonomy-classification's extract_poll_id.",
  props: {
    trigger_event: {
      type: "any",
      label: "Trigger Event",
      description: "The raw trigger event object",
    },
  },
  async run({ $ }) {
    const event = this.trigger_event || {};
    const body = event.body || {};

    const pollId = body.poll_id || body.POLL_ID || event.poll_id || event.POLL_ID;
    const spreadsheetId =
      body.spreadsheet_id ||
      body.SPREADSHEET_ID ||
      event.spreadsheet_id ||
      event.SPREADSHEET_ID;

    if (!pollId || !spreadsheetId) {
      $.flow.exit(
        "Missing poll_id and/or spreadsheet_id. Expected {poll_id, spreadsheet_id} in the POST body."
      );
    }

    // poll_id is interpolated into SQL downstream; reject anything but the known
    // poll-id shape so a malformed mapping entry can't inject SQL.
    if (!/^[A-Za-z0-9_-]+$/.test(pollId)) {
      throw new Error(`Refusing unsafe poll_id: ${JSON.stringify(pollId)}`);
    }

    $.export("$summary", `Reporting ${pollId} → ${spreadsheetId}`);
    return { poll_id: pollId, spreadsheet_id: spreadsheetId };
  },
});
