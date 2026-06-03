export default defineComponent({
  name: "Trigger Classification",
  description:
    "Explicit handoff (ADR-0001): POSTs each unclassified poll_id to the taxonomy-classification HTTP trigger after the catalog upsert. Attempts every poll, then THROWS if any POST failed — a broken handoff must red-banner the deploy, never silently drop polls (the failure mode the retired snowflake-new-row source caused).",
  props: {
    poll_rows: {
      type: "any",
      label: "Unclassified poll rows",
      description: "Rows from find_unclassified: [{ POLL_ID }]",
    },
  },
  async run({ $ }) {
    // taxonomy-classification workflow's HTTP trigger (hi_VOHV2Qx).
    const ENDPOINT = "https://eoy3u5dwjaak2ub.m.pipedream.net";

    const rows = Array.isArray(this.poll_rows) ? this.poll_rows : [];
    const pollIds = [...new Set(rows.map((r) => r?.POLL_ID).filter(Boolean))];

    if (pollIds.length === 0) {
      $.export("$summary", "No unclassified polls to hand off");
      return { posted: [], failed: [] };
    }

    const posted = [];
    const failed = [];

    for (const pollId of pollIds) {
      try {
        const resp = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ POLL_ID: pollId }),
        });
        if (resp.ok) {
          posted.push(pollId);
        } else {
          failed.push({ pollId, status: resp.status });
        }
      } catch (err) {
        failed.push({ pollId, error: err.message });
      }
    }

    $.export(
      "$summary",
      `Handed off ${posted.length}/${pollIds.length} poll(s) to classification` +
        (failed.length ? `; ${failed.length} FAILED` : "")
    );

    if (failed.length > 0) {
      throw new Error(
        `Classification handoff failed for ${failed.length} poll(s): ${JSON.stringify(failed)}`
      );
    }

    return { posted, failed };
  },
});
