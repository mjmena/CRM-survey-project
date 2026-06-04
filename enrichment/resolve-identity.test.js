import { describe, it, expect } from "vitest";
import {
  normalizeHem,
  isValidHem,
  computeEventWindow,
  resolveHem,
} from "./resolve-identity.js";

// A real SPICE payload external_id (64 lowercase hex) — ground-truth HEM shape.
const HEM_A = "d53d2946b265a57d76c6c702f2caa6d1ecb4ac2a8b2d18edc49a602e27120657";
const HEM_B = "d7d8c138767bc65156638ec8c4b97bc435f8d525e9f14df3ff88b4efbc28a4b1";

describe("normalizeHem", () => {
  it("lowercases and trims", () => {
    expect(normalizeHem(`  ${HEM_A.toUpperCase()}  `)).toBe(HEM_A);
  });
  it("treats null/empty/whitespace as absent (null)", () => {
    expect(normalizeHem(null)).toBeNull();
    expect(normalizeHem(undefined)).toBeNull();
    expect(normalizeHem("")).toBeNull();
    expect(normalizeHem("   ")).toBeNull();
  });
  it("keeps a present-but-malformed value non-null (so caller can fall through)", () => {
    expect(normalizeHem("not-a-hash")).toBe("not-a-hash");
  });
});

describe("isValidHem", () => {
  it("accepts exactly 64 lowercase hex chars", () => {
    expect(isValidHem(HEM_A)).toBe(true);
  });
  it("rejects wrong length", () => {
    expect(isValidHem(HEM_A.slice(0, 63))).toBe(false);
    expect(isValidHem(HEM_A + "a")).toBe(false);
  });
  it("rejects non-hex and non-strings", () => {
    expect(isValidHem(HEM_A.slice(0, 63) + "g")).toBe(false);
    expect(isValidHem(HEM_A.toUpperCase())).toBe(false); // must be pre-normalized
    expect(isValidHem(null)).toBe(false);
    expect(isValidHem(12345)).toBe(false);
  });
});

describe("computeEventWindow", () => {
  it("pads the SPICE submission range by one day each side", () => {
    // SPICE: 2026-05-29 13:29 .. 2026-06-02 19:40 -> 05-28 .. 06-03
    expect(
      computeEventWindow("2026-05-29 13:29:55.695", "2026-06-02 19:40:55.657")
    ).toEqual({ start: "2026-05-28", end: "2026-06-03" });
  });
  it("honors a custom pad and crosses month boundaries", () => {
    expect(computeEventWindow("2026-03-01", "2026-03-31", 2)).toEqual({
      start: "2026-02-27",
      end: "2026-04-02",
    });
  });
  it("accepts Date objects", () => {
    expect(
      computeEventWindow(new Date("2026-05-29T13:29:55Z"), new Date("2026-06-02T19:40:55Z"))
    ).toEqual({ start: "2026-05-28", end: "2026-06-03" });
  });
  it("throws on unparseable input", () => {
    expect(() => computeEventWindow("nope", "2026-06-02")).toThrow();
  });
});

describe("resolveHem", () => {
  it("uses the payload external_id when valid (payload wins)", () => {
    expect(resolveHem({ payloadExternalId: HEM_A, recoveredUserId: HEM_B })).toEqual({
      hem: HEM_A,
      hemSource: "payload",
    });
  });
  it("normalizes the chosen hem (uppercase/whitespace payload)", () => {
    expect(
      resolveHem({ payloadExternalId: `  ${HEM_A.toUpperCase()} `, recoveredUserId: null })
    ).toEqual({ hem: HEM_A, hemSource: "payload" });
  });
  it("recovers from events when payload is blank", () => {
    expect(resolveHem({ payloadExternalId: "", recoveredUserId: HEM_B })).toEqual({
      hem: HEM_B,
      hemSource: "events",
    });
  });
  it("falls through to events when payload is present but malformed", () => {
    expect(resolveHem({ payloadExternalId: "garbage", recoveredUserId: HEM_B })).toEqual({
      hem: HEM_B,
      hemSource: "events",
    });
  });
  it("yields a null hem (not a throw) when both are absent or invalid", () => {
    expect(resolveHem({ payloadExternalId: null, recoveredUserId: null })).toEqual({
      hem: null,
      hemSource: null,
    });
    expect(resolveHem({ payloadExternalId: "bad", recoveredUserId: "also-bad" })).toEqual({
      hem: null,
      hemSource: null,
    });
    expect(resolveHem({})).toEqual({ hem: null, hemSource: null });
    expect(resolveHem()).toEqual({ hem: null, hemSource: null });
  });
});
