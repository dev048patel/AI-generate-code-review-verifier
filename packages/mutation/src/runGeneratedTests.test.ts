import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runGeneratedTests } from "./runGeneratedTests.js";

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

describe("runGeneratedTests", () => {
  it("reports all-passing results for a healthy generated suite", async () => {
    sandboxDir = await mkdtemp(path.join(sandboxParent, "gen-pass-"));
    await writeFile(path.join(sandboxDir, "calc.ts"), `export function add(a: number, b: number) { return a + b; }\n`);
    await writeFile(
      path.join(sandboxDir, "calc.acrv.gen.test.ts"),
      `import { describe, it, expect } from "vitest";
import { add } from "./calc";
describe("add", () => {
  it("adds", () => { expect(add(1, 2)).toBe(3); });
});
`,
    );

    const result = await runGeneratedTests({ sandboxDir });
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  }, 30_000);

  it("reports failures with messages when a generated test fails", async () => {
    sandboxDir = await mkdtemp(path.join(sandboxParent, "gen-fail-"));
    await writeFile(path.join(sandboxDir, "calc.ts"), `export function add(a: number, b: number) { return a + b; }\n`);
    await writeFile(
      path.join(sandboxDir, "calc.acrv.gen.test.ts"),
      `import { describe, it, expect } from "vitest";
import { add } from "./calc";
describe("add", () => {
  it("is wrong on purpose", () => { expect(add(1, 2)).toBe(999); });
});
`,
    );

    const result = await runGeneratedTests({ sandboxDir });
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.testName).toContain("wrong on purpose");
  }, 30_000);
});
