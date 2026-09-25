import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  computeTrustScore,
  type ExecutionInfo,
  type GeneratedTestFile,
  type MutationResult,
  type ReviewResult,
  type TestRunResult,
} from "@acrv/core";
import { reviewCostUsd, type LLMProvider } from "@acrv/llm";
import {
  detectProject,
  findProjectDir,
  installDependencies,
  installStryker,
  LocalProcessExecutor,
  runProjectGeneratedTests,
  runProjectMutation,
  toMutateRanges,
  type ChangedRange,
  type SandboxExecutor,
} from "@acrv/mutation";
import { analyzeDiff, generateTests, newReview, UNTRUSTED_SKIP_REASON, type DiffAnalysis } from "./analysis.js";
import { gitDiff, readFilesAtRevision } from "./git.js";
import { safeRelative } from "./runReview.js";

const CODE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|__mocks__)\//;

/** Everything the execute phase produces -- serializable, so it can cross from a no-secrets CI job to a reporting job. */
export interface WorkspaceExecution {
  headSha: string;
  execution: ExecutionInfo;
  generatedTests: GeneratedTestFile[];
  testRun?: TestRunResult;
  ownTestsMutation?: MutationResult;
}

export interface WorkspaceSource {
  /** A git checkout of the PR (working tree at headSha, with baseSha's history available). */
  repoDir: string;
  baseSha: string;
  headSha: string;
}

export interface ExecuteWorkspaceOptions extends WorkspaceSource {
  /** Directory the executor may see; must contain repoDir. Defaults to repoDir. */
  workspaceDir?: string;
  executor?: SandboxExecutor;
  untrusted?: boolean;
  /** Run `<pm> install` when node_modules is missing. Default true. */
  installDependencies?: boolean;
  skipMutation?: boolean;
  /** Monorepos: at most this many projects are executed per PR. */
  maxProjects?: number;
  /** Precomputed diff/contents; read from git when absent. */
  diffText?: string;
  afterFileContents?: Record<string, string>;
}

async function loadSource(src: WorkspaceSource): Promise<{ diffText: string; afterFileContents: Record<string, string> }> {
  const diffText = await gitDiff(src.repoDir, src.baseSha, src.headSha);
  const files = [...diffText.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((m) => m[1] as string);
  const afterFileContents = await readFilesAtRevision(src.repoDir, src.headSha, files);
  return { diffText, afterFileContents };
}

/**
 * The execute phase: runs the PR's code. Generated tests are written next to
 * the code they test inside the real checkout (so the project's own imports,
 * tsconfig and dependencies resolve), and the changed lines are mutation-tested
 * against the project's own test suite. Every step degrades to a note instead
 * of failing the review.
 */
export async function executeWorkspace(options: ExecuteWorkspaceOptions): Promise<WorkspaceExecution> {
  const repoDir = path.resolve(options.repoDir);
  const workspaceDir = path.resolve(options.workspaceDir ?? repoDir);
  const executor = options.executor ?? new LocalProcessExecutor();
  const notes: string[] = [];

  const source =
    options.diffText !== undefined && options.afterFileContents
      ? { diffText: options.diffText, afterFileContents: options.afterFileContents }
      : await loadSource(options);
  const analysis = analyzeDiff(source.diffText, source.afterFileContents);
  const { generatedTests } = generateTests(analysis.changedFunctions);

  const execution: ExecutionInfo = { executor: executor.kind, isolated: executor.isolated, notes };
  const result: WorkspaceExecution = { headSha: options.headSha, execution, generatedTests };

  if (analysis.trivial.isTrivial) return result;
  if (options.untrusted && !executor.allowsUntrustedCode) {
    execution.skippedReason = UNTRUSTED_SKIP_REASON;
    return result;
  }

  const projects = groupByProject(repoDir, analysis, notes);
  const selected = [...projects.entries()].slice(0, options.maxProjects ?? 3);
  if (projects.size > selected.length) {
    notes.push(`Only the first ${selected.length} of ${projects.size} changed projects were executed.`);
  }

  const testRuns: TestRunResult[] = [];
  const mutations: MutationResult[] = [];

  for (const [projectDir, files] of selected) {
    const label = path.relative(repoDir, projectDir) || ".";
    const project = await detectProject(projectDir, repoDir);

    if (options.installDependencies !== false && project.packageManager && !existsSync(path.join(project.installDir, "node_modules"))) {
      try {
        await installDependencies({ project, workspaceDir, executor });
      } catch (err) {
        notes.push(`[${label}] dependency install failed; tests may not import: ${firstLine(err)}`);
      }
    }

    // 1. Generated tests, next to their sources, then removed so they never reach the project's own suite.
    const projectTests = generatedTests.filter((t) => files.has(sourceOf(t, analysis)));
    if (projectTests.length > 0) {
      const written: string[] = [];
      try {
        for (const test of projectTests) {
          const target = path.join(repoDir, safeRelative(test.file));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, test.content, "utf-8");
          written.push(target);
        }
        testRuns.push(
          await runProjectGeneratedTests({
            projectDir,
            testFiles: written.map((w) => toPosix(path.relative(projectDir, w))),
            workspaceDir,
            executor,
          }),
        );
      } finally {
        await Promise.all(written.map((w) => rm(w, { force: true })));
      }
    }

    // 2. The project's own tests vs. mutants of exactly the changed lines.
    if (options.skipMutation) continue;
    if (!project.testRunner) {
      notes.push(`[${label}] no supported test runner (vitest, jest, mocha) found; own-test mutation testing skipped.`);
      continue;
    }
    const ranges: ChangedRange[] = [];
    for (const file of analysis.parsed.files) {
      if (!files.has(file.newPath) || file.changedLines.length === 0) continue;
      ranges.push(...toMutateRanges(toPosix(path.relative(projectDir, path.join(repoDir, file.newPath))), file.changedLines));
    }
    if (ranges.length === 0) continue;
    try {
      await installStryker({ project, workspaceDir, executor, runner: project.testRunner });
      const mutation = await runProjectMutation({ project, runner: project.testRunner, ranges, workspaceDir, executor });
      mutations.push(rebaseMutationPaths(mutation, repoDir, projectDir));
    } catch (err) {
      const message = String(err);
      notes.push(
        /initial test run|dry.?run|There were failed tests/i.test(message)
          ? `[${label}] the project's own test suite already fails at this commit, so mutation testing could not run.`
          : `[${label}] own-test mutation testing failed: ${firstLine(err)}`,
      );
    }
  }

  if (testRuns.length > 0) result.testRun = mergeTestRuns(testRuns);
  if (mutations.length > 0) result.ownTestsMutation = mergeMutations(mutations);
  return result;
}

export interface RunWorkspaceReviewInput extends ExecuteWorkspaceOptions {
  repo: string;
  prNumber: number;
  prTitle: string;
  prDescription: string;
  prUrl?: string;
  prAuthor?: string;
  /** Omit to skip the LLM (e.g. the no-secrets execute job of the GitHub Action). */
  llmProvider?: LLMProvider;
  /**
   * Result of an execute phase that already ran elsewhere. Its content was
   * produced next to untrusted code, so it's validated against headSha and
   * treated as advisory evidence, never as a reason to skip analysis.
   */
  execution?: WorkspaceExecution;
  /** false: don't execute here (and none was supplied) -- analysis only. */
  execute?: boolean;
}

/** Reviews a PR from a real checkout: LLM + rules on the true diff, plus the execute phase (run here or supplied). */
export async function runWorkspaceReview(input: RunWorkspaceReviewInput): Promise<ReviewResult> {
  const start = Date.now();
  const source =
    input.diffText !== undefined && input.afterFileContents
      ? { diffText: input.diffText, afterFileContents: input.afterFileContents }
      : await loadSource(input);
  const analysis = analyzeDiff(source.diffText, source.afterFileContents);
  const review = newReview({ ...input, isLive: true }, analysis);
  if (analysis.trivial.isTrivial) {
    review.latencyMs = Date.now() - start;
    return review;
  }

  if (input.llmProvider) {
    review.risk = await input.llmProvider.classify({
      repo: input.repo,
      prTitle: input.prTitle,
      prDescription: input.prDescription,
      files: analysis.parsed.files,
      changedFunctions: analysis.changedFunctions,
    });
    review.costUsd = reviewCostUsd(review.risk);
  }

  let execution = input.execution;
  if (execution && execution.headSha !== input.headSha) {
    const staleSha = execution.headSha;
    execution = undefined;
    review.execution = {
      executor: "none",
      isolated: false,
      skippedReason: `Execution results were for commit ${staleSha.slice(0, 7)}, not ${input.headSha.slice(0, 7)}, and were discarded.`,
    };
  } else if (!execution && input.execute !== false) {
    execution = await executeWorkspace({ ...input, ...source });
  }

  if (execution) {
    review.generatedTests = execution.generatedTests;
    review.testRun = execution.testRun;
    review.ownTestsMutation = execution.ownTestsMutation;
    review.execution = execution.execution;
  } else {
    review.generatedTests = generateTests(analysis.changedFunctions).generatedTests;
    review.execution ??= { executor: "none", isolated: false, skippedReason: "Code execution was not requested." };
  }

  review.trustScore = computeTrustScore({
    risk: review.risk,
    ownTestsMutation: review.ownTestsMutation,
    testRun: review.testRun,
    ruleFindings: analysis.ruleFindings,
  });
  review.latencyMs = Date.now() - start;
  return review;
}

/** Changed, non-test code files grouped by the package.json directory that owns them. */
function groupByProject(repoDir: string, analysis: DiffAnalysis, notes: string[]): Map<string, Set<string>> {
  const realRepo = realpathSync(repoDir);
  const projects = new Map<string, Set<string>>();
  for (const file of analysis.parsed.files) {
    if (file.isDeleted || file.isBinary || !CODE_RE.test(file.newPath) || TEST_RE.test(file.newPath)) continue;
    if (file.newPath.endsWith(".d.ts")) continue;
    const projectDir = findProjectDir(repoDir, safeRelative(file.newPath));
    if (!projectDir) continue;
    // A PR can commit a directory symlink; never follow one out of the checkout.
    const real = realpathSync(projectDir);
    if (real !== realRepo && !real.startsWith(realRepo + path.sep)) {
      notes.push(`Skipped ${file.newPath}: its project directory resolves outside the checkout.`);
      continue;
    }
    if (!projects.has(projectDir)) projects.set(projectDir, new Set());
    projects.get(projectDir)!.add(file.newPath);
  }
  return projects;
}

function sourceOf(test: GeneratedTestFile, analysis: DiffAnalysis): string {
  return analysis.changedFunctions.find((fn) => fn.id === test.targetFunctionId)?.file ?? "";
}

function rebaseMutationPaths(m: MutationResult, repoDir: string, projectDir: string): MutationResult {
  return {
    ...m,
    survivedMutants: m.survivedMutants.map((s) => ({
      ...s,
      file: toPosix(path.relative(repoDir, path.join(projectDir, s.file))),
    })),
  };
}

export function mergeTestRuns(runs: TestRunResult[]): TestRunResult {
  return runs.reduce((a, b) => ({
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    total: a.total + b.total,
    durationMs: a.durationMs + b.durationMs,
    failures: [...a.failures, ...b.failures],
  }));
}

export function mergeMutations(results: MutationResult[]): MutationResult {
  const sum = results.reduce((a, b) => ({
    mutationScore: 0,
    killed: a.killed + b.killed,
    survived: a.survived + b.survived,
    timeout: a.timeout + b.timeout,
    noCoverage: a.noCoverage + b.noCoverage,
    totalMutants: a.totalMutants + b.totalMutants,
    survivedMutants: [...a.survivedMutants, ...b.survivedMutants],
    durationMs: a.durationMs + b.durationMs,
  }));
  const scored = sum.killed + sum.survived + sum.timeout + sum.noCoverage;
  sum.mutationScore = scored === 0 ? 100 : Math.round(((sum.killed + sum.timeout) / scored) * 100);
  return sum;
}

function firstLine(err: unknown): string {
  return String(err).split("\n")[0]!.slice(0, 300);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
