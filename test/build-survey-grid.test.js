// Lives OUTSIDE the Pipedream step dir (per the synced-project skill: only the
// step's own entry.mjs + sibling .mjs helpers belong there). Imports the pure
// transform helper directly — deploy-bundled into the step AND unit-tested here.
import { describe, it, expect } from "vitest";
import {
  buildResponseGrid,
  buildSurveyGrid,
  buildSurveyGrids,
  buildTallyBlock,
  questionOrderFromTally,
  META_COLUMNS,
  DEMOGRAPHIC_COLUMNS,
  SECTION_DIVIDER,
} from "../sync-to-google-sheet-p_LQCoVRY/build_survey_grid/transform.mjs";

const META = META_COLUMNS.map(([l]) => l);
const DEMO = DEMOGRAPHIC_COLUMNS.map(([l]) => l);
const NOW = "06/04/2026, 12:00:00";

// Survey order (from answer index) is: self_view first, flavors second — the
// REVERSE of alphabetical, so it proves we order by the survey, not the text.
const Q_SELF = "Do you use GLP-1?";
const Q_FLAV = "Which flavors?";

// Tally rows carry QUESTION_ORDER (MIN answer index). flavors=0, self=1.
const tallyRows = [
  { POLL_ID: "p1", TOTAL_RESPONSES: 2, QUESTION: Q_FLAV, QUESTION_ORDER: 0, ANSWER: "Citrus", RESPONSE_COUNT: 1 },
  { POLL_ID: "p1", TOTAL_RESPONSES: 2, QUESTION: Q_FLAV, QUESTION_ORDER: 0, ANSWER: "Berry", RESPONSE_COUNT: 1 },
  { POLL_ID: "p1", TOTAL_RESPONSES: 2, QUESTION: Q_SELF, QUESTION_ORDER: 1, ANSWER: "Yes", RESPONSE_COUNT: 1 },
  { POLL_ID: "p1", TOTAL_RESPONSES: 2, QUESTION: Q_SELF, QUESTION_ORDER: 1, ANSWER: "No", RESPONSE_COUNT: 1 },
];

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
  ANSWERS: { [Q_SELF]: "Yes", [Q_FLAV]: "Citrus, Berry" },
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
  ANSWERS: { [Q_SELF]: "No" },
};

describe("questionOrderFromTally", () => {
  it("orders by QUESTION_ORDER (survey order), not alphabetically", () => {
    expect(questionOrderFromTally(tallyRows)).toEqual([Q_FLAV, Q_SELF]);
  });
});

describe("buildResponseGrid", () => {
  it("leads with answers (in given order), then the demographic contract", () => {
    const [header] = buildResponseGrid([enriched], [Q_FLAV, Q_SELF]);
    expect(header).toEqual([...META, Q_FLAV, Q_SELF, ...DEMO]);
  });

  it("falls back to alphabetical question order when none is given", () => {
    const [header] = buildResponseGrid([enriched]);
    // alphabetical: "Do you use GLP-1?" < "Which flavors?"
    expect(header).toEqual([...META, Q_SELF, Q_FLAV, ...DEMO]);
  });

  it("appends questions not present in the given order (nothing dropped)", () => {
    const [header] = buildResponseGrid([enriched], [Q_FLAV]); // omit Q_SELF
    expect(header).toEqual([...META, Q_FLAV, Q_SELF, ...DEMO]);
  });

  it("emits exactly one data row per response", () => {
    const grid = buildResponseGrid([enriched, unresolved], [Q_FLAV, Q_SELF]);
    expect(grid.length).toBe(1 + 2);
  });

  it("places answer values before demographic values in the right columns", () => {
    const [header, row] = buildResponseGrid([enriched], [Q_FLAV, Q_SELF]);
    expect(row[header.indexOf(Q_SELF)]).toBe("Yes");
    expect(row[header.indexOf("Age Band")]).toBe("65+");
    // an answer column sits before any demographic column
    expect(header.indexOf(Q_SELF)).toBeLessThan(header.indexOf("Age Band"));
  });

  it("comma-joins multi-select whether pre-joined string or array", () => {
    const [h1, r1] = buildResponseGrid([enriched], [Q_FLAV]);
    expect(r1[h1.indexOf(Q_FLAV)]).toBe("Citrus, Berry");
    const arr = { ...enriched, ANSWERS: { [Q_FLAV]: ["Citrus", "Berry"] } };
    const [h2, r2] = buildResponseGrid([arr], [Q_FLAV]);
    expect(r2[h2.indexOf(Q_FLAV)]).toBe("Citrus, Berry");
  });

  it("blanks demographic cells for an unresolved respondent (story 9)", () => {
    const [header, row] = buildResponseGrid([unresolved], [Q_SELF]);
    for (const [label] of DEMOGRAPHIC_COLUMNS) {
      expect(row[header.indexOf(label)]).toBe("");
    }
  });

  it("blanks a question cell when the response has no answer for it", () => {
    const grid = buildResponseGrid([enriched, unresolved], [Q_FLAV, Q_SELF]);
    const header = grid[0];
    expect(grid[2][header.indexOf(Q_FLAV)]).toBe(""); // unresolved didn't answer flavors
  });

  it("formats booleans as Yes/No and null as blank", () => {
    const [header, row] = buildResponseGrid([enriched], [Q_SELF]);
    expect(row[header.indexOf("Has Children")]).toBe("No");
    expect(row[header.indexOf("Affinity: Investor")]).toBe("Yes");
  });

  it("parses a JSON-string ANSWERS variant (Pipedream shape)", () => {
    const asString = { ...enriched, ANSWERS: JSON.stringify(enriched.ANSWERS) };
    const [header, row] = buildResponseGrid([asString], [Q_SELF]);
    expect(row[header.indexOf(Q_SELF)]).toBe("Yes");
  });
});

describe("buildTallyBlock", () => {
  it("renders questions in survey order with counts and %", () => {
    const { block } = buildTallyBlock("p1", tallyRows, NOW);
    expect(block[0]).toEqual(["p1"]);
    expect(block[1]).toEqual(["Total Responses:", 2, `Last Updated: ${NOW} ET`]);
    const qLines = block.filter((r) => typeof r[0] === "string" && r[0].startsWith('Q: '));
    expect(qLines).toEqual([[`Q: "${Q_FLAV}"`], [`Q: "${Q_SELF}"`]]); // flavors first
    expect(block).toContainEqual(["Yes", 1, "50.0%"]);
  });
});

describe("buildSurveyGrid", () => {
  it("stacks the tally block, a divider, then the per-response grid", () => {
    const grid = buildSurveyGrid("p1", tallyRows, [enriched, unresolved], NOW);
    expect(grid[0]).toEqual(["p1"]);
    const dividerIdx = grid.findIndex((r) => r[0] === SECTION_DIVIDER);
    expect(dividerIdx).toBeGreaterThan(0);
    // response header follows the divider, leading with answers then demographics
    const respHeader = grid[dividerIdx + 2];
    expect(respHeader).toEqual([...META, Q_FLAV, Q_SELF, ...DEMO]);
    // two response data rows after the header
    expect(grid.length - (dividerIdx + 3)).toBe(2);
  });

  it("survives a poll with no responses (empty inputs)", () => {
    const grid = buildSurveyGrid("p1", [], [], NOW);
    expect(grid[0]).toEqual(["p1"]);
    expect(grid).toContainEqual([SECTION_DIVIDER]);
  });
});

describe("buildSurveyGrids", () => {
  it("groups tally + response rows into one grid per POLL_ID", () => {
    const grids = buildSurveyGrids(
      tallyRows,
      [enriched, unresolved, { ...enriched, POLL_ID: "p2", INGESTION_ID: 9 }],
      NOW
    );
    expect(Object.keys(grids).sort()).toEqual(["p1", "p2"]);
  });
});
