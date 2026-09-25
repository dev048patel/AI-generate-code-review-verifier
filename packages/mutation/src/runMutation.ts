import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MutationResult } from "@acrv/core";
import { buildStrykerConfig } from "./strykerConfig.js";
import { parseMutationReport } from "./parseMutationReport.js";
import { writeSandboxVitestConfig } from "./sandboxSetup.js";
import { LocalProcessExecutor, type SandboxExecutor } from "./sandboxExecutor.js";

export interface RunMutationOptions {
  /**
   * Absolute path to the sandbox directory containing the target source
   * file(s) and generated test file(s). MUST live under this repo's root so
   * Node's module resolution finds the hoisted Stryker/vitest installs by
   * walking up parent directories -- no per-review `npm install` needed.
   */
  sandboxDir: string;
  /** Glob(s) for the file(s) to mutate, relative to sandboxDir, e.g. ["pay.ts"]. */
  mutateGlobs: string[];
  /** Glob(s) for generated test files, relative to sandboxDir. */
  testGlobs?: string[];
  timeoutMs?: number;
  /** Where Stryker runs. Defaults to a local child process (trusted code only). */
  executor?: SandboxExecutor;
}

/**
 * Runs Stryker mutation testing against a sandboxed copy of the changed
 * file(s) plus their generated tests, and returns a structured
 * MutationResult. This is the "does the generated test suite actually
 * constrain the code" check: a high survived-mutant count means the tests
 * pass regardless of behavior changes, i.e. they don't really test anything.
 */
export async function runMutation(options: RunMutationOptions): Promise<MutationResult> {
  const { sandboxDir, mutateGlobs, testGlobs = ["**/*.acrv.gen.test.ts"], timeoutMs = 120_000 } = options;

  const reportRelPath = path.join("reports", "mutation", "mutation.json");
  const config = buildStrykerConfig({ mutateGlobs, testGlobs, reportFileName: reportRelPath });

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(path.join(sandboxDir, "stryker.config.json"), JSON.stringify(config, null, 2), "utf-8");
  await writeSandboxVitestConfig(sandboxDir, testGlobs);

  const executor = options.executor ?? new LocalProcessExecutor();

  const start = Date.now();
  await executor.run({
    tool: "stryker",
    args: ["run", "stryker.config.json"],
    workspaceDir: sandboxDir,
    timeoutMs,
    // Thresholds are disabled in strykerConfig.ts, so a normal run
    // (including one with survived mutants) always exits 0.
    acceptExitCode: (code) => code === 0,
    label: "Stryker",
  });
  const durationMs = Date.now() - start;

  const reportPath = path.join(sandboxDir, reportRelPath);
  return parseMutationReport(reportPath, sandboxDir, durationMs);
}
