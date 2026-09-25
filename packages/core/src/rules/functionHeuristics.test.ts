import { describe, expect, it } from "vitest";
import { extractChangedFunctions } from "../diff/extractChangedFunctions.js";
import { runFunctionHeuristics } from "./functionHeuristics.js";

function fnFor(source: string, name: string) {
  const fns = extractChangedFunctions("f.ts", source, allLines(source));
  const fn = fns.find((f) => f.name === name);
  if (!fn) throw new Error(`function ${name} not found`);
  return fn;
}

function allLines(source: string): number[] {
  return Array.from({ length: source.split("\n").length }, (_, i) => i + 1);
}

describe("runFunctionHeuristics", () => {
  it("flags an off-by-one loop bound", () => {
    const fn = fnFor(
      `function sumAll(arr: number[]): number {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i];
  }
  return total;
}`,
      "sumAll",
    );
    const findings = runFunctionHeuristics(fn);
    expect(findings.some((f) => f.title.includes("Off-by-one"))).toBe(true);
  });

  it("flags an out-of-bounds index access", () => {
    const fn = fnFor(
      `function last(arr: number[]): number {
  return arr[arr.length];
}`,
      "last",
    );
    const findings = runFunctionHeuristics(fn);
    expect(findings.some((f) => f.title.includes("Out-of-bounds"))).toBe(true);
  });

  it("flags an unguarded access on an optional parameter", () => {
    const fn = fnFor(
      `function getName(user?: { name: string }): string {
  return user.name;
}`,
      "getName",
    );
    const findings = runFunctionHeuristics(fn);
    expect(findings.some((f) => f.title.includes("null/undefined dereference"))).toBe(true);
  });

  it("does not flag a guarded access on an optional parameter", () => {
    const fn = fnFor(
      `function getName(user?: { name: string }): string {
  if (!user) return "";
  return user.name;
}`,
      "getName",
    );
    const findings = runFunctionHeuristics(fn);
    expect(findings.some((f) => f.title.includes("null/undefined dereference"))).toBe(false);
  });

  it("flags division by zero with no guard", () => {
    const fn = fnFor(
      `function average(sum: number, count: number): number {
  return sum / count;
}`,
      "average",
    );
    const findings = runFunctionHeuristics(fn);
    expect(findings.some((f) => f.title.includes("division by zero"))).toBe(true);
  });

  it("does not flag division when a zero guard exists", () => {
    const fn = fnFor(
      `function average(sum: number, count: number): number {
  if (count === 0) return 0;
  return sum / count;
}`,
      "average",
    );
    const findings = runFunctionHeuristics(fn);
    expect(findings.some((f) => f.title.includes("division by zero"))).toBe(false);
  });

  it("returns no findings for clean, fully-guarded code", () => {
    const fn = fnFor(
      `function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}`,
      "clamp",
    );
    expect(runFunctionHeuristics(fn)).toHaveLength(0);
  });
});
