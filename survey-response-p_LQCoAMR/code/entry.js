export default defineComponent({
  props: {
    db: {
      type: "data_store",
    },
  },
  async run({ steps, $ }) {
    const body = steps.trigger.event.body;
    const { answers, poll_id } = body;

    // 1. Define Cache Key
    const cacheKey = `stats_${poll_id || 'default'}`;

    // 2. Get Current Stats (or init)
    // Structure: { q1: { "Option A": 10, ... }, q2: ... }
    let stats = (await this.db.get(cacheKey)) || {};

    // 3. Update Stats with new answers
    if (answers && Array.isArray(answers)) {
      for (const { question, answer } of answers) {
        if (!stats[question]) stats[question] = {};
        if (!stats[question][answer]) stats[question][answer] = 0;
        stats[question][answer]++;
      }

      // Save back to Data Store
      await this.db.set(cacheKey, stats);
    }

    // 4. Transform to Frontend Format (Percentages)
    const responsePayload = {};

    for (const [qId, counts] of Object.entries(stats)) {
      const options = Object.entries(counts);
      const total = options.reduce((sum, [_, count]) => sum + count, 0);

      responsePayload[qId] = options.map(([label, count]) => ({
        label,
        percentage: total === 0 ? 0 : Math.round((count / total) * 100)
      })).sort((a, b) => b.percentage - a.percentage);
    }

    // 5. Send Response Immediately
    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: responsePayload,
    });

    // 6. Return data for next steps (Snowflake)
    return body;
  },
});
