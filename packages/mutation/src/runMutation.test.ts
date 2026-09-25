import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMutation } from "./runMutation.js";

// Sandboxes MUST live under the repo root so Node's module resolution finds
// the hoisted Stryker/vitest install by walking up parent directories.
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const sandboxParent = path.join(repoRoot, "sandbox-runs");

let sandboxDir: string | undefined;

beforeAll(async () => {
  await mkdir(sandboxParent, { recursive: true });
});

afterEach(async () => {
  if (sandboxDir) {
    await rm(sandboxDir, { recursive: true, force: true });
    sandboxDir = undefined;
  }
});

describe("runMutation (real Stryker integration)", () => {
  it("reports a mutation score below 100 when tests don't cover a boundary case", async () => {
    sandboxDir = await mkdtemp(path.join(sandboxParent, "mut-weak-"));
    await writeFile(
      path.join(sandboxDir, "calc.ts"),
      `export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
`,
      "utf-8",
    );
    // Deliberately weak: never exercises n === min or n === max, so the
    // EqualityOperator mutants (< -> <=, > -> >=) should survive.
    await writeFile(
      path.join(sandboxDir, "calc.acrv.gen.test.ts"),
      `import { describe, it, expect } from "vitest";
import { clamp } from "./calc";

describe("clamp", () => {
  it("clamps below range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it("clamps above range", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
`,
      "utf-8",
    );

    const result = await runMutation({ sandboxDir, mutateGlobs: ["calc.ts"], timeoutMs: 60_000 });

    expect(result.totalMutants).toBeGreaterThan(0);
    expect(result.survived).toBeGreaterThan(0);
    expect(result.mutationScore).toBeLessThan(100);
    expect(result.survivedMutants.length).toBeGreaterThan(0);
    expect(result.survivedMutants[0]?.file).toBe("calc.ts");
  }, 90_000);

  it("reports a higher mutation score when tests cover inclusive boundaries", async () => {
    // Unlike clamp() above, isInRange()'s boundary values produce an
    // observably different result under an EqualityOperator mutation
    // (>= -> >, <= -> <), so boundary-value tests can actually kill those
    // mutants here -- a case picked deliberately to demonstrate the
    // improvement, since clamp()'s boundaries happen to be output-equivalent
    // under that same mutation (a well-known "equivalent mutant" wrinkle).
    sandboxDir = await mkdtemp(path.join(sandboxParent, "mut-strong-"));
    await writeFile(
      path.join(sandboxDir, "calc.ts"),
      `export function isInRange(n: number, min: number, max: number): boolean {
  return n >= min && n <= max;
}
`,
      "utf-8",
    );
    await writeFile(
      path.join(sandboxDir, "calc.acrv.gen.test.ts"),
      `import { describe, it, expect } from "vitest";
import { isInRange } from "./calc";

describe("isInRange", () => {
  it("is false below range", () => { expect(isInRange(-5, 0, 10)).toBe(false); });
  it("is false above range", () => { expect(isInRange(15, 0, 10)).toBe(false); });
  it("is true within range", () => { expect(isInRange(5, 0, 10)).toBe(true); });
  it("is true at the min boundary", () => { expect(isInRange(0, 0, 10)).toBe(true); });
  it("is true at the max boundary", () => { expect(isInRange(10, 0, 10)).toBe(true); });
});
`,
      "utf-8",
    );

    const result = await runMutation({ sandboxDir, mutateGlobs: ["calc.ts"], timeoutMs: 60_000 });
    expect(result.mutationScore).toBeGreaterThanOrEqual(90);
  }, 90_000);
});
