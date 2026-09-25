import { describe, expect, it } from "vitest";
import { extractChangedFunctions } from "./extractChangedFunctions.js";

const SOURCE = `
export function add(a: number, b: number): number {
  return a + b;
}

export const multiply = (a: number, b: number): number => {
  return a * b;
};

class Calculator {
  divide(a: number, b: number): number {
    if (b === 0) throw new Error("divide by zero");
    return a / b;
  }
}
`;

describe("extractChangedFunctions", () => {
  it("finds a top-level function declaration touched by the diff", () => {
    // line 3 is `return a + b;` inside `add`
    const fns = extractChangedFunctions("calc.ts", SOURCE, [3]);
    expect(fns.some((f) => f.name === "add" && f.kind === "function")).toBe(true);
  });

  it("finds an arrow function assigned to a const", () => {
    const fns = extractChangedFunctions("calc.ts", SOURCE, [7]);
    expect(fns.some((f) => f.name === "multiply")).toBe(true);
  });

  it("finds a class method", () => {
    const fns = extractChangedFunctions("calc.ts", SOURCE, [12]);
    expect(fns.some((f) => f.name === "divide" && f.kind === "method")).toBe(true);
  });

  it("does not report functions untouched by the diff", () => {
    const fns = extractChangedFunctions("calc.ts", SOURCE, [3]);
    expect(fns.some((f) => f.name === "multiply")).toBe(false);
    expect(fns.some((f) => f.name === "divide")).toBe(false);
  });

  it("captures parameter info", () => {
    const fns = extractChangedFunctions("calc.ts", SOURCE, [3]);
    const add = fns.find((f) => f.name === "add")!;
    expect(add.params.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("returns nothing when no lines overlap any function", () => {
    const fns = extractChangedFunctions("calc.ts", SOURCE, [1]);
    expect(fns).toHaveLength(0);
  });

  it("marks top-level exported functions and consts as exported", () => {
    const fns = extractChangedFunctions("calc.ts", SOURCE, [3, 7]);
    expect(fns.find((f) => f.name === "add")?.isExported).toBe(true);
    expect(fns.find((f) => f.name === "multiply")?.isExported).toBe(true);
  });

  it("reports the literal union return-type annotation, not a checker-narrowed type", () => {
    const source = `export function safeLast(items: number[]): number | undefined {
  if (items.length === 0) return undefined;
  return items[items.length - 1];
}`;
    const fns = extractChangedFunctions("calc.ts", source, [2, 3]);
    expect(fns.find((f) => f.name === "safeLast")?.returnTypeText).toBe("number | undefined");
  });

  it("marks non-exported functions as not exported", () => {
    const source = `function helper(n: number): number {
  return n * 2;
}`;
    const fns = extractChangedFunctions("calc.ts", source, [2]);
    expect(fns.find((f) => f.name === "helper")?.isExported).toBe(false);
  });
});
