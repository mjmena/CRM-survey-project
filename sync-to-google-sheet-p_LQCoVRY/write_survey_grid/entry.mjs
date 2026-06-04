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

    // title (lowercased) -> sheetId, so we can resize the grid before writing.
    const tabIdByName = new Map(
      (spreadsheet.sheets || []).map((s) => [
        s.properties.title.toLowerCase(),
        s.properties.sheetId,
      ])
    );

    const results = [];

    for (const pollId of pollIds) {
      // One tab per poll. Sheet tab titles cap at 100 chars.
      const tabName = `Survey ${pollId}`.slice(0, 100);
      const escapedName = tabName.replace(/'/g, "''");
      const grid = grids[pollId];
      const rowCount = Math.max(grid.length, 1);
      const colCount = Math.max(...grid.map((r) => r.length), 1);

      // 1. Create the tab if it doesn't exist, capturing its sheetId.
      let sheetId = tabIdByName.get(tabName.toLowerCase());
      if (sheetId === undefined) {
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
        const created = await createResp.json();
        sheetId = created.replies[0].addSheet.properties.sheetId;
        tabIdByName.set(tabName.toLowerCase(), sheetId);
      }

      // 2. Clear the tab (full resync — so async identity enrichment backfills
      //    onto rows that were blank when first written; ADR-0003). Clearing
      //    also wipes any stale cells to the right of this run's ragged rows.
      const clearResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}/values/${encodeURIComponent(`'${escapedName}'`)}:clear`,
        { method: "POST", headers: authHeaders, body: JSON.stringify({}) }
      );
      if (!clearResp.ok) throw new Error(`Failed to clear tab "${tabName}": ${clearResp.status}`);

      // 3. Resize the grid to fit. A cleared/new tab keeps its old (often ~1000)
      //    row count; a chunked write at e.g. A5001 would otherwise land beyond
      //    the grid and 400. Pre-sizing keeps every chunk in-bounds.
      const resizeResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}:batchUpdate`,
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            requests: [{
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { rowCount, columnCount: colCount } },
                fields: "gridProperties.rowCount,gridProperties.columnCount",
              },
            }],
          }),
        }
      );
      if (!resizeResp.ok) throw new Error(`Failed to resize tab "${tabName}" to ${rowCount}x${colCount}: ${resizeResp.status}`);

      // 4. Write the grid in row-chunks so no single request is oversized. Each
      //    chunk is now within the pre-sized grid bounds.
      const CHUNK_ROWS = 5000;
      for (let start = 0; start < grid.length; start += CHUNK_ROWS) {
        const chunk = grid.slice(start, start + CHUNK_ROWS);
        const range = `'${escapedName}'!A${start + 1}`;
        const writeResp = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheet_id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
          {
            method: "PUT",
            headers: authHeaders,
            body: JSON.stringify({ values: chunk }),
          }
        );
        if (!writeResp.ok) {
          throw new Error(
            `Failed to write rows ${start + 1}-${start + chunk.length} to tab "${tabName}": ${writeResp.status}`
          );
        }
      }

      results.push({ tabName, rows: grid.length });
    }

    $.export("$summary", `Updated ${results.length} tab(s): ${results.map((r) => r.tabName).join(", ")}`);
    return results;
  },
});
