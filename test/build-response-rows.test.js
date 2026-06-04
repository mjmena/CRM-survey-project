// Lives OUTSIDE the Pipedream step dir (per the synced-project skill: only the
// step's own entry.mjs + sibling .mjs helpers belong there). Imports the pure
// transform helper directly — deploy-bundled into the step AND unit-tested here.
import { describe, it, expect } from "vitest";
import {
  buildResponseGrid,
  buildResponseGrids,
  META_COLUMNS,
  DEMOGRAPHIC_COLUMNS,
} from "../sync-to-google-sheet-p_LQCoVRY/build_response_rows/transform.mjs";

const META = META_COLUMNS.map(([l]) => l);
const DEMO = DEMOGRAPHIC_COLUMNS.map(([l]) => l);

// A fully-enriched response with two questions (one multi-select pre-joined in SQL).
const enriched = {
  POLL_ID: "p1",
  INGESTION_ID: 1,
  SUBMITTED_AT: "2026-05-29 13:29:55",
  MARKET_NAME: "Miami",
  IDENTITY_SOURCE: "payload",
  AGE_BAND: "65+",
  GENERATION: "Boomer",
  INCOME_HH: "$100,000 - $149,999",
  NET_WORTH_HH: "Greater than $499,999",
  EDUCATION: "Completed College",
  OCCUPATION_CATEGORY: "Professional",
  MARITAL_STATUS: "Married",
  HOME_OWNER: "Home Owner",
  ETHNIC_GROUP: "Western European",
  HAS_CHILDREN_HH: false,
  GENDER: "F",
  STATE: "FL",
  DMA: 528,
  AFFINITY_INVESTOR: true,
  AFFINITY_HOMEOWNER: true,
  ANSWERS: { "Do you use GLP-1?": "Yes", "Which flavors?": "Citrus, Berry" },
};

// An unresolved response: blank demographics, one answer.
const unresolved = {
  POLL_ID: "p1",
  INGESTION_ID: 2,
  SUBMITTED_AT: "2026-05-30 09:00:00",
  MARKET_NAME: null,
  IDENTITY_SOURCE: null,
  AGE_BAND: null,
  GENERATION: null,
  INCOME_HH: null,
  NET_WORTH_HH: null,
  EDUCATION: null,
  OCCUPATION_CATEGORY: null,
  MARITAL_STATUS: null,
  HOME_OWNER: null,
  ETHNIC_GROUP: null,
  HAS_CHILDREN_HH: null,
  GENDER: null,
  STATE: null,
  DMA: null,
  AFFINITY_INVESTOR: null,
  AFFINITY_HOMEOWNER: null,
  ANSWERS: { "Do you use GLP-1?": "No" },
};

describe("buildResponseGrid", () => {
  it("header is the meta + fixed demographic contract + sorted question columns", () => {
    const [header] = buildResponseGrid([enriched]);
    expect(header).toEqual([
      ...META,
      ...DEMO,
      "Do you use GLP-1?", // sorted before "Which flavors?"
      "Which flavors?",
    ]);
  });

  it("emits exactly one data row per response", () => {
    const grid = buildResponseGrid([enriched, unresolved]);
    expect(grid.length).toBe(1 + 2); // header + 2 rows
  });

  it("places demographic and answer values in the right columns", () => {
    const [, row] = buildResponseGrid([enriched]);
    const ageIdx = META.length + DEMO.indexOf("Age Band");
    expect(row[ageIdx]).toBe("65+");
    const qIdx = META.length + DEMO.length; // first question column
    expect(row[qIdx]).toBe("Yes"); // "Do you use GLP-1?"
  });

  it("keeps multi-select comma-joined (pre-joined string passes through)", () => {
    const [header, row] = buildResponseGrid([enriched]);
    const idx = header.indexOf("Which flavors?");
    expect(row[idx]).toBe("Citrus, Berry");
  });

  it("comma-joins multi-select when it arrives as an array", () => {
    const arr = { ...enriched, ANSWERS: { "Which flavors?": ["Citrus", "Berry"] } };
    const [header, row] = buildResponseGrid([arr]);
    expect(row[header.indexOf("Which flavors?")]).toBe("Citrus, Berry");
  });

  it("blanks demographic cells for an unresolved respondent (story 9)", () => {
    const [, row] = buildResponseGrid([unresolved]);
    for (let c = META.length; c < META.length + DEMO.length; c++) {
      expect(row[c]).toBe("");
    }
  });

  it("blanks a question cell when the response has no (non-catch-all) answer for it", () => {
    // unresolved answered only the first question; the second is a catch-all
    // that was dropped upstream, so its column is blank here (story 21).
    const grid = buildResponseGrid([enriched, unresolved]);
    const header = grid[0];
    const unresolvedRow = grid[2];
    expect(unresolvedRow[header.indexOf("Which flavors?")]).toBe("");
  });

  it("formats booleans as Yes/No and null as blank", () => {
    const [header, row] = buildResponseGrid([enriched]);
    expect(row[header.indexOf("Has Children")]).toBe("No");
    expect(row[header.indexOf("Affinity: Investor")]).toBe("Yes");
  });

  it("parses a JSON-string ANSWERS variant (Pipedream shape)", () => {
    const asString = { ...enriched, ANSWERS: JSON.stringify(enriched.ANSWERS) };
    const [header, row] = buildResponseGrid([asString]);
    expect(row[header.indexOf("Do you use GLP-1?")]).toBe("Yes");
  });
});

describe("buildResponseGrids", () => {
  it("groups rows into one grid per POLL_ID", () => {
    const grids = buildResponseGrids([
      enriched,
      unresolved,
      { ...enriched, POLL_ID: "p2", INGESTION_ID: 9 },
    ]);
    expect(Object.keys(grids).sort()).toEqual(["p1", "p2"]);
    expect(grids.p1.length).toBe(1 + 2);
    expect(grids.p2.length).toBe(1 + 1);
  });
});
