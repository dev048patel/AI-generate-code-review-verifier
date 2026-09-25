import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addStrykerCommand,
  buildProjectStrykerConfig,
  detectProject,
  findProjectDir,
  installCommand,
  STRYKER_VERSION,
  toMutateRanges,
} from "./projectRun.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "acrv-proj-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("installCommand / addStrykerCommand", () => {
  it("never runs lifecycle scripts during a networked install, for any package manager", () => {
    for (const pm of ["npm", "pnpm", "yarn"] as const) {
      expect(installCommand(pm).args).toContain("--ignore-scripts");
      expect(addStrykerCommand(pm, "vitest").args).toContain("--ignore-scripts");
    }
  });

  it("pins Stryker core and the runner plugin to the same version", () => {
    const { args } = addStrykerCommand("npm", "jest");
    expect(args).toContain(`@stryker-mutator/core@${STRYKER_VERSION}`);
    expect(args).toContain(`@stryker-mutator/jest-runner@${STRYKER_VERSION}`);
    expect(args).toContain("--no-save");
  });

  it("only passes workspace-root flags inside a workspace", () => {
    expect(addStrykerCommand("pnpm", "vitest").args).not.toContain("-w");
    expect(addStrykerCommand("pnpm", "vitest", true).args).toContain("-w");
    expect(addStrykerCommand("yarn", "vitest", true).args).toContain("-W");
  });
});

describe("toMutateRanges", () => {
  it("merges nearby changed lines into ranges", () => {
    expect(toMutateRanges("a.ts", [10, 3, 4, 5, 11, 30])).toEqual([
      { file: "a.ts", startLine: 3, endLine: 5 },
      { file: "a.ts", startLine: 10, endLine: 11 },
      { file: "a.ts", startLine: 30, endLine: 30 },
    ]);
  });

  it("feeds Stryker `file:start-end` mutate entries", () => {
    const config = buildProjectStrykerConfig("vitest", toMutateRanges("src/a.ts", [1, 2]), "r.json");
    expect(config.mutate).toEqual(["src/a.ts:1-2"]);
    expect(config.plugins).toEqual(["@stryker-mutator/vitest-runner"]);
  });
});

describe("detectProject", () => {
  it("finds the owning package, the monorepo lockfile, and the test runner", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await writeFile(path.join(repo, "package-lock.json"), "{}");
    const pkg = path.join(repo, "packages", "api");
    await mkdir(path.join(pkg, "src"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ devDependencies: { jest: "^29" } }));

    const projectDir = findProjectDir(repo, "packages/api/src/handler.ts");
    expect(projectDir).toBe(pkg);
    const project = await detectProject(projectDir!, repo);
    expect(project).toMatchObject({ installDir: repo, packageManager: "npm", testRunner: "jest", isWorkspaceRoot: true });
  });

  it("recognises pnpm and a vitest test script", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(path.join(repo, "pnpm-lock.yaml"), "");
    const project = await detectProject(repo, repo);
    expect(project).toMatchObject({ packageManager: "pnpm", testRunner: "vitest", isWorkspaceRoot: false });
  });
});
