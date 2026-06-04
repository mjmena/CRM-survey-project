export default defineComponent({
  name: "Write Survey Grid to Google Sheet",
  description:
    "For each poll, finds or creates its single 'Survey <poll>' tab and full-resyncs (clear + write) the stacked grid (tally + per-response demographics)",
  props: {
    google_sheets: {
      type: "app",
      app: "google_sheets",
    },
    spreadsheet_id: {
      type: "string",
      label: "Spreadsheet ID",
      description: "The ID of the Google Sheet to write to (from the URL)",
    },
    grids: {
      type: "any",
      label: "Survey Grids",
      description: "Map of poll_id to 2D grid arrays from build_survey_grid",
    },
  },
  async run({ $ }) {
    const grids = this.grids || {};
    const pollIds = Object.keys(grids);

    if (pollIds.length === 0) {
      $.export("$summary", "No grids to write");
      return;
    }

    const authHeaders = {
      "Authorization": `Bearer ${this.google_sheets.$auth.oauth_access_token}`,
      "Content-Type": "application/json",
    };

    // Fetch existing tabs once
    const spreadsheetResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}`,
      { headers: authHeaders }
    );
    if (!spreadsheetResp.ok) throw new Error(`Failed to fetch spreadsheet: ${spreadsheetResp.status}`);
    const spreadsheet = await spreadsheetResp.json();

    const existingTabs = new Set(
      (spreadsheet.sheets || []).map((s) => s.properties.title.toLowerCase())
    );

    const results = [];

    for (const pollId of pollIds) {
      // One tab per poll. Sheet tab titles cap at 100 chars.
      const tabName = `Survey ${pollId}`.slice(0, 100);
      const escapedName = tabName.replace(/'/g, "''");
      const grid = grids[pollId];

      // 1. Create tab if it doesn't exist
      if (!existingTabs.has(tabName.toLowerCase())) {
        const createResp = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}:batchUpdate`,
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              requests: [{ addSheet: { properties: { title: tabName } } }],
            }),
          }
        );
        if (!createResp.ok) throw new Error(`Failed to create tab "${tabName}": ${createResp.status}`);
        existingTabs.add(tabName.toLowerCase());
      }

      // 2. Clear the tab (full resync — so async identity enrichment backfills
      //    onto rows that were blank when first written; ADR-0003).
      const clearResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}/values/${encodeURIComponent(`'${escapedName}'`)}:clear`,
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({}),
        }
      );
      if (!clearResp.ok) throw new Error(`Failed to clear tab "${tabName}": ${clearResp.status}`);

      // 3. Write the grid
      const writeResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}/values/${encodeURIComponent(`'${escapedName}'!A1`)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify({ values: grid }),
        }
      );
      if (!writeResp.ok) throw new Error(`Failed to write to tab "${tabName}": ${writeResp.status}`);

      results.push({ tabName, rows: grid.length });
    }

    $.export("$summary", `Updated ${results.length} tab(s): ${results.map((r) => r.tabName).join(", ")}`);
    return results;
  },
});
