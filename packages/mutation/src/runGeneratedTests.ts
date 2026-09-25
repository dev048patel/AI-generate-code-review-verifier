import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TestRunResult } from "@acrv/core";
import { writeSandboxVitestConfig } from "./sandboxSetup.js";
import { LocalProcessExecutor, type SandboxExecutor } from "./sandboxExecutor.js";

export interface RunGeneratedTestsOptions {
  /** Absolute path to the sandbox directory, same constraints as runMutation's. */
  sandboxDir: string;
  testGlobs?: string[];
  timeoutMs?: number;
  /** Where the tests run. Defaults to a local child process (trusted code only). */
  executor?: SandboxExecutor;
}

interface VitestJsonReport {
  numPassedTests: number;
  numFailedTests: number;
  numTotalTests: number;
  testResults: Array<{
    assertionResults: Array<{ title: string; status: string; failureMessages: string[] }>;
  }>;
}

/**
 * Executes the generated tests for a review in the sandbox (before mutation
 * testing runs) and reports a plain pass/fail summary. This is the "sandboxed
 * execution" step from the spec: the generated code and tests are run in an
 * isolated directory, never against the reviewer's own process.
 */
export async function runGeneratedTests(options: RunGeneratedTestsOptions): Promise<TestRunResult> {
  const { sandboxDir, testGlobs = ["**/*.acrv.gen.test.ts"], timeoutMs = 60_000 } = options;
  const executor = options.executor ?? new LocalProcessExecutor();

  await writeSandboxVitestConfig(sandboxDir, testGlobs);
  const outputFile = "acrv-test-result.json";

  const start = Date.now();
  try {
    await executor.run({
      tool: "vitest",
      args: ["run", "--config", "vitest.config.mjs", "--reporter=json", `--outputFile=${outputFile}`],
      workspaceDir: sandboxDir,
      timeoutMs,
      // vitest exits 1 when any test fails -- that's expected and meaningful
      // (a generated test failing is a signal, not a tooling error).
      acceptExitCode: (code) => code === 0 || code === 1,
      label: "vitest",
    });
  } catch (err) {
    return {
      passed: 0,
      failed: 0,
      total: 0,
      durationMs: Date.now() - start,
      failures: [{ testName: "(sandbox execution)", message: String(err) }],
    };
  }
  const durationMs = Date.now() - start;

  const raw = await readFile(path.join(sandboxDir, outputFile), "utf-8");
  return parseVitestJsonReport(raw, durationMs);
}

/** Parses vitest's `--reporter=json` output into a TestRunResult. */
export function parseVitestJsonReport(raw: string, durationMs: number): TestRunResult {
  const report = JSON.parse(raw) as VitestJsonReport;

  const failures = report.testResults
    .flatMap((f) => f.assertionResults)
    .filter((a) => a.status === "failed")
    .map((a) => ({ testName: a.title, message: a.failureMessages[0] ?? "unknown failure" }));

  return {
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    total: report.numTotalTests,
    durationMs,
    failures,
  };
}
