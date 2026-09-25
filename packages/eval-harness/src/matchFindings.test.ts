import { describe, expect, it } from "vitest";
import type { Finding, SeededBug } from "@acrv/core";
import { matchFindings } from "./matchFindings.js";

function bug(overrides: Partial<SeededBug> = {}): SeededBug {
  return {
    id: "bug-1",
    description: "test bug",
    location: { file: "a.ts", line: 10 },
    category: "off-by-one",
    expectDetection: true,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-1",
    source: "rule",
    severity: "high",
    file: "a.ts",
    line: 10,
    title: "finding",
    detail: "detail",
    ...overrides,
  };
}

describe("matchFindings", () => {
  it("counts a finding at the exact bug location as a true positive", () => {
    const result = matchFindings([bug()], [finding()], false);
    expect(result.truePositives).toEqual(["bug-1"]);
    expect(result.falseNegatives).toHaveLength(0);
    expect(result.falsePositives).toBe(0);
  });

  it("counts a finding within tolerance as a match", () => {
    const result = matchFindings([bug({ location: { file: "a.ts", line: 10 } })], [finding({ line: 12 })], false);
    expect(result.truePositives).toEqual(["bug-1"]);
  });

  it("does not match a finding outside tolerance or in a different file", () => {
    const farAway = matchFindings([bug()], [finding({ line: 50 })], false);
    expect(farAway.truePositives).toHaveLength(0);
    expect(farAway.falseNegatives).toEqual(["bug-1"]);
    expect(farAway.falsePositives).toBe(1);

    const wrongFile = matchFindings([bug()], [finding({ file: "other.ts" })], false);
    expect(wrongFile.truePositives).toHaveLength(0);
  });

  it("does not double-count multiple findings pointing at the same bug as extra false positives", () => {
    const result = matchFindings([bug()], [finding({ id: "f1" }), finding({ id: "f2", line: 11 })], false);
    expect(result.truePositives).toEqual(["bug-1"]);
    expect(result.falsePositives).toBe(0);
  });

  it("ignores mutation-sourced findings for precision/recall bookkeeping", () => {
    const result = matchFindings([bug()], [finding({ source: "mutation" })], false);
    expect(result.truePositives).toHaveLength(0);
    expect(result.falsePositives).toBe(0);
  });

  it("treats every finding as a false positive on a clean control with no matching bugs", () => {
    const result = matchFindings([], [finding()], true);
    expect(result.falsePositives).toBe(1);
    expect(result.correctlyLeftClean).toBe(false);
  });

  it("marks a clean control with zero findings as correctly left clean", () => {
    const result = matchFindings([], [], true);
    expect(result.correctlyLeftClean).toBe(true);
  });

  it("does not require a clean flag for non-clean cases with no findings", () => {
    const result = matchFindings([bug({ expectDetection: false })], [], false);
    expect(result.correctlyLeftClean).toBe(true);
    expect(result.falseNegatives).toHaveLength(0); // expectDetection: false bugs aren't counted
  });
});
