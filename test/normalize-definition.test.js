import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { normalizeDefinition } from "../sync-braze-to-snowflake-p_V9CgJMd/flatten_catalog/normalize-definition.mjs";

const def = {
  poll_id: "p",
  option_sets: { brands: [{ value: "Pluto TV" }, { value: "None Of These", is_catch_all: true, exclusive: true }] },
  pages: [
    { page_id: "a", groups: [{ questions: ["heard"] }] },
    { page_id: "b", groups: [{ questions: ["fav", "note"] }] },
  ],
  questions: {
    heard: { type: "multi", question: "Heard of?", required: true, options: "brands" },
    fav: {
      type: "matrix", question: "Opinion?", required: true, show_results: false,
      rows: ["Pluto TV", "Samsung TV Plus"], rows_from: "heard", options_from: "heard",
      options: [{ value: "Good" }, { value: "Bad" }],
    },
    note: { type: "text", question: "Anything else?" },
  },
};

describe("normalizeDefinition", () => {
  const out = normalizeDefinition(def);

  it("resolves option_sets references", () => {
    expect(out.questions.heard.options).toEqual(def.option_sets.brands);
  });

  it("expands a matrix into one question per row, in place on its page", () => {
    expect(out.pages[1].groups[0].questions).toEqual(["fav__pluto_tv", "fav__samsung_tv_plus", "note"]);
    expect(out.questions.fav).toBeUndefined();
    expect(out.questions.fav__samsung_tv_plus).toMatchObject({
      type: "single",
      question: "Opinion? — Samsung TV Plus",
      row: "Samsung TV Plus",
      matrix: { key: "fav", question: "Opinion?" },
      required: true,
      show_results: false,
      options_from: "heard",
      auto_advance: false,
      options: [{ value: "Good" }, { value: "Bad" }],
      show_if_answer: { question: "heard", op: "array_contains", values: ["Samsung TV Plus"] },
    });
  });

  it("makes multi matrix rows multi questions and leaves text questions alone", () => {
    const m = normalizeDefinition({ questions: { m: { type: "matrix", multi: true, question: "Q", rows: ["R"], options: "s" } }, option_sets: { s: [{ value: "X" }] } });
    expect(m.questions.m__r).toMatchObject({ type: "multi", options: [{ value: "X" }] });
    expect(out.questions.note).toBe(def.questions.note);
  });

  it("leaves a definition without matrices or option sets unchanged", () => {
    const plain = { pages: [{ page_id: "a", groups: [{ questions: ["q"] }] }], questions: { q: { type: "single", options: [{ value: "Y" }] } } };
    expect(normalizeDefinition(plain)).toEqual(plain);
  });

  // The renderers carry inline copies; this keeps them identical to the module.
  it("matches the inline copies in the renderers", () => {
    const body = s => s.slice(s.indexOf("function normalizeDefinition"), s.indexOf("return Object.assign({}, def, { pages, questions });"));
    const src = body(fs.readFileSync(new URL("../sync-braze-to-snowflake-p_V9CgJMd/flatten_catalog/normalize-definition.mjs", import.meta.url), "utf8"));
    for (const f of ["../poll-iam.html", "../prism_template_for_landingpage.liquid", "../prism-survey-agent-system-prompt.md"]) {
      const copy = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      expect(copy.includes("function normalizeDefinition"), f).toBe(true);
      const norm = s => s.replace(/^\s+/gm, "");
      expect(norm(body(copy)), f).toBe(norm(src));
    }
  });
});
