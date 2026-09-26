import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAi, detectBot, landing } from "./authorship.js";
import { factsAtRef, analyzeHistory } from "./history.js";
import { buildFlows } from "./flow.js";
import { buildReport } from "./prompts.js";

describe("detectAi", () => {
  const c = (subject: string, body = "", author = "Dev", email = "dev@example.com") => ({ subject, body, author, email });

  it("recognizes the marks AI tools leave on commits", () => {
    expect(detectAi(c("Add login", "🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>"))?.tool).toBe("Claude Code");
    expect(detectAi(c("Add login", "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"))).toEqual({ tool: "Claude", evidence: "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" });
    expect(detectAi(c("Fix bug", "Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>"))?.tool).toBe("GitHub Copilot");
    expect(detectAi(c("Refactor", "", "Cursor Agent", "cursoragent@cursor.com"))?.tool).toBe("Cursor");
    expect(detectAi(c("aider: add rate limiter"))?.tool).toBe("Aider");
    expect(detectAi(c("Update deps", "", "devin-ai-integration[bot]", "158243242+devin-ai-integration[bot]@users.noreply.github.com"))?.tool).toBe("Devin");
  });

  it("doesn't mistake people, or dependency bots, for AI tools", () => {
    expect(detectAi(c("Fix typo", "", "Claude Monet", "claude@example.com"))).toBeUndefined();
    expect(detectAi(c("Fix typo", "", "Devin Smith", "devin@example.com"))).toBeUndefined();
    expect(detectAi(c("Bump lodash", "", "dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com"))).toBeUndefined();
    expect(detectBot({ author: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" })).toBe("dependabot");
    expect(detectBot({ author: "Dev", email: "dev@example.com" })).toBeUndefined();
  });
});

describe("landing", () => {
  it("tells merged pull requests from direct pushes", () => {
    expect(landing({ subject: "Merge pull request #42 from acme/login", body: "Add login rate limiting", parents: 2 })).toEqual({ via: "pr", pr: 42, title: "Add login rate limiting" });
    expect(landing({ subject: "Add login rate limiting (#43)", body: "", parents: 1 })).toEqual({ via: "pr", pr: 43, title: "Add login rate limiting" });
    expect(landing({ subject: "hotfix: typo", body: "", parents: 1 })).toEqual({ via: "push" });
  });
});

let repo: string;
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}
async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  }
  git("add", "-A");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

describe("per-commit history and the report", () => {
  it("credits AI tools used on a merged branch, and leaves generated files out of the token count", async () => {
    await commit({ "src/a.ts": "export const a = 1;" }, "init");
    git("checkout", "-q", "-b", "feature");
    await commit({ "src/b.ts": "export const b = 2;\n".repeat(10), "dist/bundle.js": "x".repeat(5000) }, "Add b\n\nCo-authored-by: Cursor <cursoragent@cursor.com>");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "feature", "-m", "Merge pull request #3 from acme/feature\n\nAdd b");
    const a = await analyzeHistory(repo);
    const merge = a.commits[a.commits.length - 1]!;
    expect(merge.landing).toEqual({ via: "pr", pr: 3, title: "Add b" });
    expect(merge.ai).toEqual({ tool: "Cursor", evidence: "1 of 1 commits in this merge: Co-authored-by: Cursor <cursoragent@cursor.com>" });
    expect(merge.chars!.added).toBe("export const b = 2;\n".length * 10); // dist/bundle.js not counted
  });

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "acrv-report-"));
    git("init", "-q", "-b", "main");
  });
  afterEach(async () => rm(repo, { recursive: true, force: true }));

  it("records who wrote each commit, how it landed, and what it did to requests and the architecture", async () => {
    await commit({ "src/app.ts": `app.use(rateLimit()); app.get("/health", (req, res) => res.json({ ok: true }));` }, "init");
    const bad = await commit(
      {
        "src/app.ts": `import bcrypt from "bcrypt";
app.get("/health", (req, res) => res.json({ ok: true }));
app.post("/login", async (req, res) => {
  const user = await db.user.findUnique({ where: { email: req.body.email } });
  if (!(await bcrypt.compare(req.body.password, user.hash))) return res.status(401).json({});
  res.json({ ok: true });
});`,
      },
      "Add login (#7)\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
    );
    const a = await analyzeHistory(repo, { repo: "acme/api" });
    const c = a.commits.find((x) => x.sha === bad)!;
    expect(c.ai).toEqual({ tool: "Claude", evidence: "Co-Authored-By: Claude <noreply@anthropic.com>" });
    expect(c.landing).toEqual({ via: "pr", pr: 7, title: "Add login" });
    expect(c.chars!.added).toBeGreaterThan(200);
    expect(c.flowChanges!.map((f) => `${f.label}: ${f.summary}`)).toEqual([
      "POST /login: New request path; ⚠ no rate limiter; ⚠ input isn't checked",
      "GET /health: − rate limiter",
    ]);
    expect(c.architecture).toEqual(expect.arrayContaining(["⚠ now: no rate limiter", "+ Password hashing", "+ Database", "− Rate limiter"]));
    expect(c.delta.introduced!.map((f) => f.title)).toEqual(["POST /login has no rate limiting"]);

    // The report: each open problem with a fix and a prompt, tied to the commit that caused it.
    const { facts } = await factsAtRef(repo, "HEAD");
    const r = buildReport(a, buildFlows(facts));
    expect(r.problems.map((p) => `${p.severity} ${p.kind}`)).toEqual(["high auth-route-no-rate-limit", "low unchecked-input"]);
    const limit = r.problems[0]!;
    expect(limit.introducedIn).toMatchObject({ sha: bad, ai: "Claude", pr: 7 });
    expect(limit.where).toEqual({ file: "src/app.ts", line: 3 });
    expect(limit.prompt).toContain("You are working in the repository acme/api.");
    expect(limit.prompt).toContain("Problem (high): POST /login has no rate limiting");
    expect(limit.prompt).toContain('Introduced in: ' + bad.slice(0, 7) + ' "Add login (#7)" by t (PR #7)');
    expect(limit.prompt).toContain("⚠ No rate limiter");
    expect(limit.prompt).toContain("[bcrypt.compare]");
    expect(limit.prompt).toMatch(/Done when:\n {2}- Repeated requests to POST \/login beyond the limit get 429/);
    expect(r.problems[1]!.routes).toEqual(["POST /login"]);

    expect(r.commits).toEqual([expect.objectContaining({ sha: bad, open: ["auth-route-no-rate-limit:POST /login"], fixedLater: [] })]);
    expect(r.commits[0]!.prompt).toContain(`git show ${bad.slice(0, 12)}`);
    expect(r.fixAllPrompt).toMatch(/found 2 problem\(s\)/);
    expect(r.fixAllPrompt.indexOf("[high]")).toBeLessThan(r.fixAllPrompt.indexOf("[low]"));
  });
});
