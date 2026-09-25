import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MutationResult, TestRunResult } from "@acrv/core";
import { parseMutationReport } from "./parseMutationReport.js";
import { parseVitestJsonReport } from "./runGeneratedTests.js";
import type { SandboxExecutor } from "./sandboxExecutor.js";

export type PackageManager = "npm" | "pnpm" | "yarn";
export type TestRunner = "vitest" | "jest" | "mocha";

export interface ProjectInfo {
  /** Directory with the package.json that owns the changed files. */
  projectDir: string;
  /** Directory with the lockfile (the workspace root in a monorepo), or projectDir if none. */
  installDir: string;
  packageManager: PackageManager | null;
  testRunner: TestRunner | null;
  /** installDir is a monorepo workspace root (pnpm-workspace.yaml or package.json "workspaces"). */
  isWorkspaceRoot: boolean;
}

/** Stryker version the reviewer is tested against; the runner plugin must match it exactly. */
export const STRYKER_VERSION = "10.0.0";

const LOCKFILES: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/**
 * Works out how to install and test the project that owns a set of changed
 * files: nearest package.json, the lockfile (walking up to the repo root
 * for monorepos), and which test runner the project already uses.
 */
export async function detectProject(projectDir: string, repoDir: string): Promise<ProjectInfo> {
  const pkg = await readPackageJson(projectDir);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const testScript = pkg?.scripts?.test ?? "";

  let testRunner: TestRunner | null = null;
  if ("vitest" in deps || /\bvitest\b/.test(testScript)) testRunner = "vitest";
  else if ("jest" in deps || /\bjest\b/.test(testScript)) testRunner = "jest";
  else if ("mocha" in deps || /\bmocha\b/.test(testScript)) testRunner = "mocha";

  let dir = path.resolve(projectDir);
  const stop = path.resolve(repoDir);
  for (;;) {
    for (const [file, pm] of LOCKFILES) {
      if (existsSync(path.join(dir, file))) {
        return { projectDir, installDir: dir, packageManager: pm, testRunner, isWorkspaceRoot: await isWorkspaceRoot(dir) };
      }
    }
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { projectDir, installDir: projectDir, packageManager: pkg ? "npm" : null, testRunner, isWorkspaceRoot: false };
}

async function isWorkspaceRoot(dir: string): Promise<boolean> {
  if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  const pkg = (await readPackageJson(dir)) as (PackageJson & { workspaces?: unknown }) | null;
  return Boolean(pkg?.workspaces);
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as PackageJson;
  } catch {
    return null;
  }
}

/** Nearest directory at or above `file` (and not above repoDir) that has a package.json. */
export function findProjectDir(repoDir: string, file: string): string | null {
  let dir = path.dirname(path.resolve(repoDir, file));
  const stop = path.resolve(repoDir);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Exposed for tests: the install command for a package manager, always with lifecycle scripts off. */
export function installCommand(pm: PackageManager): { command: string; args: string[] } {
  switch (pm) {
    case "npm":
      return { command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] };
    case "pnpm":
      return { command: "corepack", args: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] };
    case "yarn":
      return { command: "corepack", args: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"] };
  }
}

/** Exposed for tests: adds Stryker + the matching runner plugin without touching the committed lockfile's intent. */
export function addStrykerCommand(
  pm: PackageManager,
  runner: TestRunner,
  workspaceRoot = false,
): { command: string; args: string[] } {
  const pkgs = [`@stryker-mutator/core@${STRYKER_VERSION}`, `@stryker-mutator/${runner}-runner@${STRYKER_VERSION}`];
  switch (pm) {
    case "npm":
      return {
        command: "npm",
        args: ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", ...pkgs],
      };
    case "pnpm":
      return { command: "corepack", args: ["pnpm", "add", "-D", ...(workspaceRoot ? ["-w"] : []), "--ignore-scripts", ...pkgs] };
    case "yarn":
      return { command: "corepack", args: ["yarn", "add", "-D", ...(workspaceRoot ? ["-W"] : []), "--ignore-scripts", ...pkgs] };
  }
}

export interface InstallOptions {
  project: ProjectInfo;
  workspaceDir: string;
  executor: SandboxExecutor;
  timeoutMs?: number;
}

/**
 * Installs the project's dependencies in two phases so that no PR-controlled
 * code ever runs while the network is up:
 *  1. download with lifecycle scripts disabled (network: egress);
 *  2. run the lifecycle scripts offline (network: none) -- postinstall steps
 *     that only build locally still work, ones that phone home fail harmlessly.
 */
export async function installDependencies(options: InstallOptions): Promise<void> {
  const { project, workspaceDir, executor, timeoutMs = 600_000 } = options;
  if (!project.packageManager) return;
  const install = installCommand(project.packageManager);
  await executor.run({
    ...install,
    workspaceDir,
    cwd: project.installDir,
    timeoutMs,
    acceptExitCode: (c) => c === 0,
    label: `${project.packageManager} install`,
    network: "egress",
  });
  if (project.packageManager === "npm") {
    await executor.run({
      command: "npm",
      args: ["rebuild", "--foreground-scripts"],
      workspaceDir,
      cwd: project.installDir,
      timeoutMs,
      // Best effort: a failed offline build step shouldn't sink the review.
      acceptExitCode: () => true,
      label: "npm rebuild (offline)",
      network: "none",
    });
  }
}

export async function installStryker(options: InstallOptions & { runner: TestRunner }): Promise<void> {
  const { project, workspaceDir, executor, runner, timeoutMs = 300_000 } = options;
  if (!project.packageManager) throw new Error("Cannot install Stryker: project has no package manager");
  await executor.run({
    ...addStrykerCommand(project.packageManager, runner, project.isWorkspaceRoot),
    workspaceDir,
    cwd: project.installDir,
    timeoutMs,
    acceptExitCode: (c) => c === 0,
    label: "install Stryker",
    network: "egress",
  });
}

export interface ChangedRange {
  /** Path relative to the project directory. */
  file: string;
  startLine: number;
  endLine: number;
}

/** Exposed for tests: collapses changed line numbers into Stryker `file:start-end` mutate ranges. */
export function toMutateRanges(file: string, lines: number[], maxGap = 2): ChangedRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: ChangedRange[] = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line - last.endLine <= maxGap + 1) last.endLine = line;
    else ranges.push({ file, startLine: line, endLine: line });
  }
  return ranges;
}

export function buildProjectStrykerConfig(runner: TestRunner, ranges: ChangedRange[], reportFile: string): Record<string, unknown> {
  return {
    testRunner: runner,
    plugins: [`@stryker-mutator/${runner}-runner`],
    mutate: ranges.map((r) => `${r.file}:${r.startLine}-${r.endLine}`),
    reporters: ["json"],
    jsonReporter: { fileName: reportFile },
    coverageAnalysis: "perTest",
    concurrency: 2,
    timeoutMS: 10_000,
    thresholds: { high: 0, low: 0, break: null },
    ignoreStatic: true,
    tempDirName: ".acrv-stryker-tmp",
    cleanTempDir: "always",
  };
}

export interface ProjectMutationOptions {
  project: ProjectInfo;
  runner: TestRunner;
  ranges: ChangedRange[];
  workspaceDir: string;
  executor: SandboxExecutor;
  timeoutMs?: number;
}

/**
 * Mutation-tests only the lines this PR changed, against the project's OWN
 * test suite: every surviving or uncovered mutant is a behavior change the
 * existing tests would not notice. This is the strongest signal the reviewer
 * produces -- it needs no oracle, because the repo's tests are the oracle.
 */
export async function runProjectMutation(options: ProjectMutationOptions): Promise<MutationResult> {
  const { project, runner, ranges, workspaceDir, executor, timeoutMs = 900_000 } = options;
  const configName = "acrv.stryker.config.json";
  const reportRel = path.join("reports", "acrv-mutation.json");
  await writeFile(
    path.join(project.projectDir, configName),
    JSON.stringify(buildProjectStrykerConfig(runner, ranges, reportRel), null, 2),
    "utf-8",
  );
  const start = Date.now();
  try {
    await executor.run({
      tool: "stryker",
      toolSource: "project",
      args: ["run", configName],
      workspaceDir,
      cwd: project.projectDir,
      timeoutMs,
      acceptExitCode: (c) => c === 0,
      label: "Stryker (project tests)",
    });
  } finally {
    await rm(path.join(project.projectDir, configName), { force: true });
  }
  return parseMutationReport(path.join(project.projectDir, reportRel), project.projectDir, Date.now() - start, {
    includeNoCoverage: true,
  });
}

export interface ProjectGeneratedTestsOptions {
  projectDir: string;
  /** Generated test files, relative to projectDir, already written next to the code they test. */
  testFiles: string[];
  workspaceDir: string;
  executor: SandboxExecutor;
  timeoutMs?: number;
}

/**
 * Runs generated tests inside the real checkout with the reviewer's own
 * pinned vitest, so imports of the project's other modules resolve exactly
 * as they do for the project -- without adding anything to its dependencies.
 * `fast-check` is aliased to the reviewer's copy.
 */
export async function runProjectGeneratedTests(options: ProjectGeneratedTestsOptions): Promise<TestRunResult> {
  const { projectDir, testFiles, workspaceDir, executor, timeoutMs = 120_000 } = options;
  const configName = "acrv.gen.vitest.config.mjs";
  const outputFile = "acrv-gen-test-result.json";
  const fastCheckEntry = path.posix.join(executor.toolingRoot, "node_modules/fast-check/lib/esm/fast-check.js");
  // Plain object (no `import "vitest/config"`): the project may not have vitest installed at all.
  const config = `export default {
  cacheDir: (process.env.TMPDIR || "/tmp") + "/acrv-vite-cache",
  resolve: { alias: { "fast-check": ${JSON.stringify(fastCheckEntry)} } },
  test: { include: ${JSON.stringify(testFiles)}, globals: false, environment: "node", watch: false, passWithNoTests: true },
};
`;
  await writeFile(path.join(projectDir, configName), config, "utf-8");
  const start = Date.now();
  try {
    await executor.run({
      tool: "vitest",
      toolSource: "reviewer",
      args: ["run", "--config", configName, "--reporter=json", `--outputFile=${outputFile}`],
      workspaceDir,
      cwd: projectDir,
      timeoutMs,
      acceptExitCode: (c) => c === 0 || c === 1,
      label: "vitest (generated tests)",
    });
    const report = await readFile(path.join(projectDir, outputFile), "utf-8");
    return parseVitestJsonReport(report, Date.now() - start);
  } catch (err) {
    return {
      passed: 0,
      failed: 0,
      total: 0,
      durationMs: Date.now() - start,
      failures: [{ testName: "(sandbox execution)", message: String(err) }],
    };
  } finally {
    await rm(path.join(projectDir, configName), { force: true });
    await rm(path.join(projectDir, outputFile), { force: true });
  }
}
