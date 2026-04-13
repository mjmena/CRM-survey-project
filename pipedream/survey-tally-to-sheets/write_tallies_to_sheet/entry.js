import { axios } from "@pipedream/platform";
import google_sheets from "@pipedream/google_sheets";

export default defineComponent({
  name: "Write Tallies to Google Sheet",
  description: "For each survey, finds or creates a tab and writes the tally grid",
  props: {
    google_sheets,
    spreadsheet_id: {
      type: "string",
      label: "Spreadsheet ID",
      description: "The ID of the Google Sheet to write tallies to (from the URL)",
    },
  },
  async run({ steps, $ }) {
    const grids = steps.build_tally_grids?.grids || {};
    const pollIds = Object.keys(grids);

    if (pollIds.length === 0) {
      $.export("$summary", "No grids to write");
      return;
    }

    const headers = {
      Authorization: `Bearer ${this.google_sheets.$auth.oauth_access_token}`,
    };

    // Fetch existing tabs once
    const spreadsheet = await axios($, {
      url: `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}`,
      headers,
    });
    const existingTabs = new Set(
      (spreadsheet.sheets || []).map((s) => s.properties.title.toLowerCase())
    );

    const results = [];

    for (const pollId of pollIds) {
      const tabName = `Survey ${pollId}`;
      const escapedName = tabName.replace(/'/g, "''");
      const grid = grids[pollId];

      // 1. Create tab if it doesn't exist
      if (!existingTabs.has(tabName.toLowerCase())) {
        await axios($, {
          method: "POST",
          url: `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}:batchUpdate`,
          headers,
          data: {
            requests: [{ addSheet: { properties: { title: tabName } } }],
          },
        });
        existingTabs.add(tabName.toLowerCase());
      }

      // 2. Clear the tab
      await axios($, {
        method: "POST",
        url: `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}/values/${encodeURIComponent(`'${escapedName}'`)}:clear`,
        headers,
        data: {},
      });

      // 3. Write the grid
      await axios($, {
        method: "PUT",
        url: `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}/values/${encodeURIComponent(`'${escapedName}'!A1`)}`,
        params: { valueInputOption: "USER_ENTERED" },
        headers,
        data: { values: grid },
      });

      results.push({ tabName, rows: grid.length });
    }

    $.export("$summary", `Updated ${results.length} tab(s): ${results.map((r) => r.tabName).join(", ")}`);
    return results;
  },
});
