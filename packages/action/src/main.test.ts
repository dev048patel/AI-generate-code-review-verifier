import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readExecutionFile } from "./executionFile.js";
import { main } from "./main.js";
import { annotationCommands, escapeProperty } from "./workflowCommands.js";

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acrv-action-"));
  repo = path.join(root, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "demo", type: "module" }));
  await writeFile(path.join(repo, "src", "base.ts"), "export const one = 1;\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(
    path.join(repo, "src", "avg.ts"),
    "export function average(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n",
  );
  git("add", ".");
  git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");

  const eventPath = path.join(root, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 12,
        title: "Add average()",
        body: "",
        html_url: "https://github.com/acme/demo/pull/12",
        user: { login: "dev" },
        base: { sha: base, repo: { full_name: "acme/demo" } },
        head: { sha: head, repo: { full_name: "acme/demo" } },
      },
    }),
  );
  await writeFile(path.join(root, "out"), "");
  await writeFile(path.join(root, "summary"), "");
  env = {
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "acme/demo",
    GITHUB_OUTPUT: path.join(root, "out"),
    GITHUB_STEP_SUMMARY: path.join(root, "summary"),
    ACRV_EXECUTION_FILE: path.join(root, "acrv-execution.json"),
    ACRV_SKIP_MUTATION: "true",
    ACRV_LLM_PROVIDER: "none",
  };
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("action main", () => {
  it("execute mode runs the PR's code and writes a validated execution file", async () => {
    await main({ ...env, ACRV_MODE: "execute" });
    const file = await readExecutionFile(path.join(root, "acrv-execution.json"));
    expect(file.prNumber).toBe(12);
    expect(file.execution.testRun?.total).toBeGreaterThan(0);
    expect(await readFile(path.join(root, "summary"), "utf-8")).toContain("execute phase");
  }, 60_000);

  it("execute mode refuses to run with credentials in its environment", async () => {
    await expect(main({ ...env, ACRV_MODE: "execute", ACRV_GITHUB_TOKEN: "ghs_x" })).rejects.toThrow(/must not receive credentials/);
    await expect(main({ ...env, ACRV_MODE: "execute", ANTHROPIC_API_KEY: "sk-x" })).rejects.toThrow(/must not receive credentials/);
  });

  it("report mode folds in the execute job's results, publishes outputs, and fails below the threshold", async () => {
    await main({ ...env, ACRV_MODE: "execute" });
    await main({ ...env, ACRV_MODE: "report", ACRV_FAIL_BELOW: "101" });

    const outputs = await readFile(path.join(root, "out"), "utf-8");
    expect(outputs).toMatch(/^trust-score=\d+$/m);
    expect(outputs).toMatch(/^label=(trusted|needs-review|high-risk)$/m);
    const summary = await readFile(path.join(root, "summary"), "utf-8");
    expect(summary).toContain("Trust Score");
    expect(summary).toContain("No LLM configured");
    expect(summary).not.toContain("Code not executed");
    expect(process.exitCode).toBe(1);
  }, 60_000);

  it("report mode rejects a tampered execution file", async () => {
    await writeFile(path.join(root, "acrv-execution.json"), JSON.stringify({ version: 1, prNumber: 12, execution: { headSha: "not-a-sha" } }));
    await expect(main({ ...env, ACRV_MODE: "report" })).rejects.toThrow();
  });
});

describe("workflow commands", () => {
  it("escapes properties so a finding can't forge extra annotation fields", () => {
    expect(escapeProperty("a.ts,line=1::x")).toBe("a.ts%2Cline=1%3A%3Ax");
    const [cmd] = annotationCommands([
      { id: "1", source: "llm", severity: "high", file: "a,b.ts", line: 3, title: "t", detail: "line1\nline2" },
    ]);
    expect(cmd).toBe("::error file=a%2Cb.ts,line=3,title=[acrv] t::line1%0Aline2");
  });
});
