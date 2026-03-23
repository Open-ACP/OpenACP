import { describe, it, expect } from "vitest";
import { suggestMatch } from "../cli/suggest.js";

describe("suggestMatch", () => {
  const commands = ["start", "stop", "status", "config", "install", "uninstall", "agents", "topics", "delete-topic"];

  it("returns undefined for exact match", () => {
    expect(suggestMatch("start", commands)).toBeUndefined();
  });

  it("matches by prefix", () => {
    expect(suggestMatch("statu", commands)).toBe("status");
  });

  it("matches by substring", () => {
    expect(suggestMatch("opic", commands)).toBe("topics");
  });

  it("matches by Levenshtein distance", () => {
    expect(suggestMatch("statr", commands)).toBe("start");
  });

  it("returns undefined when no match within threshold", () => {
    expect(suggestMatch("xyzabc", commands)).toBeUndefined();
  });

  it("is case insensitive", () => {
    expect(suggestMatch("START", commands)).toBeUndefined(); // exact match
    expect(suggestMatch("STATU", commands)).toBe("status");
  });

  it("returns undefined for empty candidates", () => {
    expect(suggestMatch("foo", [])).toBeUndefined();
  });

  it("prefix wins over Levenshtein when both could match", () => {
    expect(suggestMatch("instal", commands)).toBe("install");
  });

  it("prefers shortest candidate on substring tie", () => {
    const candidates = ["delete-topic", "topics"];
    expect(suggestMatch("opic", candidates)).toBe("topics");
  });

  it("reduces maxDistance for short candidates", () => {
    const short = ["run", "new", "api"];
    // "xyz" has distance 3 from "run" — should not match
    expect(suggestMatch("xyz", short)).toBeUndefined();
    // "rin" has distance 1 from "run" — should match
    expect(suggestMatch("rin", short)).toBe("run");
  });

  it("does not substring-match inputs shorter than 3 chars", () => {
    // "to" is a prefix of "topics", so prefix matching finds it.
    // But pure substring (non-prefix) should not match for short inputs.
    expect(suggestMatch("to", ["topics"])).toBe("topics"); // prefix match
    expect(suggestMatch("pi", ["topics"])).toBeUndefined(); // "pi" is substring but < 3 chars
  });

  it("respects custom maxDistance", () => {
    expect(suggestMatch("stxxxxxxt", commands, 1)).toBeUndefined();
  });
});
