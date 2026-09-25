import { describe, expect, it } from "vitest";
import { extractChangedFunctions } from "@acrv/core";
import { generateTestsForFunction } from "./generateTests.js";

function fnFor(source: string, name: string) {
  const lines = Array.from({ length: source.split("\n").length }, (_, i) => i + 1);
  const fns = extractChangedFunctions("calc.ts", source, lines);
  const fn = fns.find((f) => f.name === name);
  if (!fn) throw new Error(`function ${name} not found`);
  return fn;
}

describe("generateTestsForFunction", () => {
  it("generates edge-case and property tests for an exported numeric function", () => {
    const fn = fnFor(
      `export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}`,
      "clamp",
    );
    const files = generateTestsForFunction(fn, { importSpecifier: "./calc" });
    expect(files).toHaveLength(2);
    expect(files.find((f) => f.kind === "edge-case")?.content).toContain("clamp(");
    expect(files.find((f) => f.kind === "property")?.content).toContain("fc.assert");
  });

  it("skips non-exported functions", () => {
    const fn = fnFor(
      `function helper(n: number): number {
  return n * 2;
}`,
      "helper",
    );
    const files = generateTestsForFunction(fn, { importSpecifier: "./calc" });
    expect(files).toHaveLength(0);
  });

  it("produces valid-looking async test code for async functions", () => {
    const fn = fnFor(
      `export async function fetchDouble(n: number): Promise<number> {
  return n * 2;
}`,
      "fetchDouble",
    );
    const files = generateTestsForFunction(fn, { importSpecifier: "./calc" });
    const property = files.find((f) => f.kind === "property")!;
    expect(property.content).toContain("asyncProperty");
    expect(property.content).toContain("await fetchDouble(");
  });

  it("includes a return-type assertion when the return type is a recognizable primitive", () => {
    const fn = fnFor(
      `export function isEven(n: number): boolean {
  return n % 2 === 0;
}`,
      "isEven",
    );
    const files = generateTestsForFunction(fn, { importSpecifier: "./calc" });
    expect(files[0]!.content).toContain('typeof result).toBe("boolean")');
  });

  it("skips generation entirely when no params have a supported type", () => {
    const fn = fnFor(
      `export function process(config: { retries: number }): void {
  doWork(config);
}`,
      "process",
    );
    const files = generateTestsForFunction(fn, { importSpecifier: "./calc" });
    expect(files).toHaveLength(0);
  });

  it("does not assert Array.isArray on a non-async function's un-awaited Promise return", () => {
    const fn = fnFor(
      `export function findAll(query: string): Promise<unknown[]> {
  return db.query(query);
}`,
      "findAll",
    );
    const files = generateTestsForFunction(fn, { importSpecifier: "./calc" });
    expect(files[0]!.content).not.toContain("Array.isArray");
  });

  it("generates array edge cases (empty array) for array-typed params", () => {
    const fn = fnFor(
      `export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}`,
      "sum",
    );
    const files = generateTestsForFunction(fn, { importSpecifier: "./calc" });
    const edge = files.find((f) => f.kind === "edge-case")!;
    expect(edge.content).toContain("[]");
  });
});
