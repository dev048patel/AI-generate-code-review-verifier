import type { AtlasFinding, CommitPoint, FindingSeverity, HistoryAnalysis, RequestFlow } from "./types.js";

/**
 * Every open problem as something a developer can act on: where it is, why
 * it matters, the fix, and a prompt to paste into an AI coding agent. The
 * prompts are templates filled from the analysis (no model call), so they
 * are free, instant and reproducible, and they carry the evidence (file,
 * line, the request's current flow) an agent needs to fix the right thing.
 */

export type ProblemKind = AtlasFinding["kind"] | "no-sign-in-check" | "unchecked-input";

export interface RepoProblem {
  id: string;
  kind: ProblemKind;
  severity: FindingSeverity;
  title: string;
  why: string;
  /** Plain steps, in order. */
  fix: string[];
  where?: { file: string; line?: number };
  /** Requests affected. */
  routes?: string[];
  /** The commit that last introduced it, when the analyzed history covers it. */
  introducedIn?: { sha: string; subject: string; author: string; date: string; ai?: string; pr?: number };
  /** Paste into Claude Code, Cursor, Copilot, … */
  prompt: string;
}

export interface CommitFix {
  sha: string;
  /** Problems this commit introduced that are still open at the newest commit. */
  open: string[];
  /** Introduced here but already fixed later. */
  fixedLater: string[];
  prompt?: string;
}

export interface RepoReport {
  repo?: string;
  problems: RepoProblem[];
  /** One prompt that works through every open problem, most severe first. */
  fixAllPrompt: string;
  commits: CommitFix[];
}

const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

function loc(where?: { file: string; line?: number }): string {
  return where ? `${where.file}${where.line ? `:${where.line}` : ""}` : "(see below)";
}

function flowText(flow: RequestFlow | undefined): string[] {
  if (!flow) return [];
  return [
    `How ${flow.method} ${flow.path} flows today:`,
    ...flow.steps.slice(0, 18).map((s, i) => `  ${i + 1}. ${"  ".repeat(s.depth)}${s.kind === "missing" ? "⚠ " : ""}${s.title}${s.code && s.kind !== "call" && s.kind !== "handler" ? ` [${s.code}]` : ""}${s.file ? ` (${s.file}${s.line ? `:${s.line}` : ""})` : ""}`),
  ];
}

const GUARDRAILS = [
  "Constraints:",
  "  - Keep the change as small as possible and match the existing code style and libraries.",
  "  - Don't change unrelated code or public behaviour beyond what's described.",
  "  - Run the existing tests (and the linter/type-checker if the repo has them) and make sure they pass.",
];

function buildPrompt(repo: string | undefined, p: Omit<RepoProblem, "prompt">, extra: { context?: string[]; done: string[] }): string {
  return [
    `You are working in the ${repo ? `repository ${repo}` : "current repository"}. Fix one problem found by static analysis of the code.`,
    "",
    `Problem (${p.severity}): ${p.title}`,
    `Where: ${loc(p.where)}${p.routes?.length ? ` · affects ${p.routes.slice(0, 8).join(", ")}${p.routes.length > 8 ? ` and ${p.routes.length - 8} more` : ""}` : ""}`,
    `Why it matters: ${p.why}`,
    ...(p.introducedIn ? [`Introduced in: ${p.introducedIn.sha.slice(0, 7)} "${p.introducedIn.subject}" by ${p.introducedIn.author}${p.introducedIn.pr ? ` (PR #${p.introducedIn.pr})` : ""}`] : []),
    ...(extra.context?.length ? ["", ...extra.context] : []),
    "",
    "What to do:",
    ...p.fix.map((f) => `  - ${f}`),
    "",
    "Done when:",
    ...extra.done.map((d) => `  - ${d}`),
    "",
    ...GUARDRAILS,
    "",
    "First read the files involved and confirm the problem is real. If it isn't (for example it's handled somewhere the analysis can't see), say so and change nothing.",
  ].join("\n");
}

type Recipe = { why: string; fix: string[]; done: string[] };

function recipe(kind: ProblemKind, subject: string): Recipe {
  switch (kind) {
    case "auth-route-no-rate-limit":
      return {
        why: "Nothing limits how often this credential endpoint can be called, so passwords can be guessed and leaked credential lists tried at full speed (brute force / credential stuffing).",
        fix: [
          `Add rate limiting to ${subject}: use the project's existing limiter if there is one, otherwise a standard one for the framework (e.g. express-rate-limit for Express, @fastify/rate-limit for Fastify, @upstash/ratelimit for serverless/Next.js).`,
          "Limit per client IP and, where the request identifies an account (email/username), per account too: about 5–10 attempts per 15 minutes is typical for login and sign-up.",
          "When the limit is hit, respond 429 Too Many Requests with a Retry-After header and a generic message (don't reveal whether the account exists).",
          "Apply it to the route or its router, not globally, so normal API traffic isn't throttled by login rules.",
        ],
        done: [
          `Repeated requests to ${subject} beyond the limit get 429 with Retry-After; requests under the limit behave exactly as before.`,
          "A test sends limit+1 requests and asserts the last one is 429.",
        ],
      };
    case "no-sign-in-check":
      return {
        why: "This request changes data, but nothing checks who is calling, so anyone who can reach the server can do it.",
        fix: [
          `Decide whether ${subject} should require a signed-in user. If it's intentionally public (a webhook, a public form), leave it and add a comment saying so.`,
          "Otherwise add the project's existing authentication middleware/guard to the route (look at how other protected routes do it and reuse that).",
          "If the data belongs to a user, also check the caller owns it (e.g. compare the record's owner id with the signed-in user) and return 403 when they don't.",
        ],
        done: [`${subject} returns 401 without credentials and works as before with them.`, "A test covers the unauthenticated case (401) and, if ownership applies, another user's record (403)."],
      };
    case "unchecked-input":
      return {
        why: "Request data is used as-is. Missing, wrong-typed or unexpected fields reach the code and the database, causing crashes, bad data, or injection risks.",
        fix: [
          "Add schema validation for the request body/query of the listed routes, using the project's validation library if it has one (zod, joi, yup, class-validator, express-validator); otherwise add zod.",
          "Validate at the start of the handler (or as route middleware), allow only the expected fields with the right types and length limits, and strip unknown fields.",
          "On failure respond 400 (or 422 if that's the project's convention) with a message naming the invalid field.",
        ],
        done: ["Each listed route rejects malformed input with 400/422 before touching the database.", "Tests cover one valid and one invalid payload per route."],
      };
    case "broken-import":
      return {
        why: "An import points at a file that doesn't exist, so the build or the first request that loads this module fails.",
        fix: ["Find where the imported module moved to (search the repo and the git history for its old name) and update the import path.", "If the module was intentionally deleted, remove or replace the code that depends on it."],
        done: ["The project builds / type-checks.", "The code path that uses the import runs in a test."],
      };
    case "broken-reference":
      return {
        why: "Code imports a name the target module no longer exports, which fails at build time or crashes at runtime.",
        fix: ["Look at the target module's current exports and the git history of that name.", "Update the import (and its uses) to the new name, or restore the export if removing it was a mistake."],
        done: ["The project builds / type-checks with no missing-export errors.", "The affected code path is exercised by a test."],
      };
    case "import-cycle":
      return {
        why: "Modules that import each other can see half-initialized values at startup (undefined imports), and can't be changed or tested independently.",
        fix: [
          "Find what each module in the cycle actually needs from the others.",
          "Break the cycle by moving the shared piece into a new module both can import, or by inverting one dependency (pass it in instead of importing it). Type-only imports can use `import type`.",
        ],
        done: ["No import cycle remains between these modules.", "The project builds and its tests pass."],
      };
    case "unused-module":
      return {
        why: "Nothing imports this module. It's either dead code that still costs reading and maintenance, or new code that was never wired in.",
        fix: ["Check whether it's loaded some way the analysis can't see (a framework convention, a script, dynamic import).", "If it's dead, delete it (and its tests). If it should be used, wire it in where it belongs."],
        done: ["Either the file is gone and the build passes, or it's imported and exercised by a test."],
      };
    case "route-removed":
      return {
        why: "An HTTP endpoint that existed before is gone. Any client still calling it now gets 404.",
        fix: ["Confirm the removal was intended and every client has moved off it.", "If it was accidental, restore it. If intended, consider a temporary 410 Gone response or a redirect, and note it in the changelog."],
        done: ["Either the route is back and tested, or its removal is deliberate and documented."],
      };
    case "no-tests":
      return {
        why: "There are no tests, so every change (including AI-written ones) ships unverified, and regressions are only found by users.",
        fix: ["Add the test runner that fits the stack (vitest or jest for JS/TS) with an npm test script.", "Start with the riskiest paths: login/sign-up, payments, and anything that writes data. Add request-level tests for the main HTTP routes."],
        done: ["`npm test` runs and passes in CI.", "The login/sign-up flow and at least one write route are covered."],
      };
    default:
      return { why: "See the finding's details.", fix: ["Investigate and fix."], done: ["The problem no longer appears in the analysis."] };
  }
}

function lastIntroduction(commits: CommitPoint[], id: string): RepoProblem["introducedIn"] {
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]!;
    if (c.delta.newFindings.includes(id)) {
      return { sha: c.sha, subject: c.subject, author: c.author, date: c.date, ...(c.ai ? { ai: c.ai.tool } : {}), ...(c.landing?.pr ? { pr: c.landing.pr } : {}) };
    }
  }
  return undefined;
}

/** Open problems at the newest commit (findings + gaps in request flows), with fixes and prompts. */
export function buildProblems(analysis: Pick<HistoryAnalysis, "head" | "commits" | "repo">, flows: RequestFlow[]): RepoProblem[] {
  const flowByRoute = new Map(flows.map((f) => [f.routeId, f]));
  const problems: RepoProblem[] = [];

  for (const f of analysis.head.findings) {
    const flow = f.nodeId ? flowByRoute.get(f.nodeId) : undefined;
    const subject = flow ? `${flow.method} ${flow.path}` : f.file ?? f.title;
    const r = recipe(f.kind, subject);
    const base: Omit<RepoProblem, "prompt"> = {
      id: f.id,
      kind: f.kind,
      severity: f.severity,
      title: f.title,
      why: r.why,
      fix: r.fix,
      ...(f.file ? { where: { file: f.file, ...(f.line ? { line: f.line } : {}) } } : {}),
      ...(flow ? { routes: [subject] } : {}),
      ...(lastIntroduction(analysis.commits, f.id) ? { introducedIn: lastIntroduction(analysis.commits, f.id) } : {}),
    };
    problems.push({ ...base, prompt: buildPrompt(analysis.repo, base, { context: [...flowText(flow), ...(f.kind === "import-cycle" ? [f.detail] : [])], done: r.done }) });
  }

  // Gaps the flows show that aren't findings: grouped per handler file so one prompt fixes them together.
  const group = (key: "missing:sign-in" | "missing:validation") => {
    const byFile = new Map<string, { flows: RequestFlow[]; severity: FindingSeverity }>();
    for (const fl of flows) {
      const gap = fl.steps.find((s) => s.key === key);
      if (!gap) continue;
      const handler = fl.steps.find((s) => s.kind === "handler");
      const file = handler?.file ?? fl.file;
      const g = byFile.get(file) ?? { flows: [], severity: "low" as FindingSeverity };
      g.flows.push(fl);
      if (SEVERITY_ORDER.indexOf(gap.severity ?? "low") < SEVERITY_ORDER.indexOf(g.severity)) g.severity = gap.severity ?? "low";
      byFile.set(file, g);
    }
    return byFile;
  };
  for (const [file, g] of group("missing:sign-in")) {
    const routes = g.flows.map((f) => `${f.method} ${f.path}`);
    const r = recipe("no-sign-in-check", routes.length === 1 ? routes[0]! : `these ${routes.length} routes`);
    const handler = g.flows[0]!.steps.find((s) => s.kind === "handler");
    const base: Omit<RepoProblem, "prompt"> = {
      id: `no-sign-in-check:${file}`,
      kind: "no-sign-in-check",
      severity: g.severity,
      title: routes.length === 1 ? `${routes[0]} changes data without a sign-in check` : `${routes.length} routes in ${file} change data without a sign-in check`,
      why: r.why,
      fix: r.fix,
      where: { file, ...(handler?.line ? { line: handler.line } : {}) },
      routes,
    };
    problems.push({ ...base, prompt: buildPrompt(analysis.repo, base, { context: flowText(g.flows[0]), done: r.done }) });
  }
  for (const [file, g] of group("missing:validation")) {
    const routes = g.flows.map((f) => `${f.method} ${f.path}`);
    const r = recipe("unchecked-input", routes.join(", "));
    const input = g.flows[0]!.steps.find((s) => s.kind === "input");
    const base: Omit<RepoProblem, "prompt"> = {
      id: `unchecked-input:${file}`,
      kind: "unchecked-input",
      severity: "low",
      title: routes.length === 1 ? `${routes[0]} uses request input without checking it` : `${routes.length} routes in ${file} use request input without checking it`,
      why: r.why,
      fix: r.fix,
      where: { file, ...(input?.line ? { line: input.line } : {}) },
      routes,
    };
    problems.push({ ...base, prompt: buildPrompt(analysis.repo, base, { context: flowText(g.flows[0]), done: r.done }) });
  }

  return problems.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.title.localeCompare(b.title));
}

export function fixAllPrompt(repo: string | undefined, problems: RepoProblem[]): string {
  const actionable = problems.filter((p) => p.severity !== "info");
  if (actionable.length === 0) return "";
  return [
    `You are working in the ${repo ? `repository ${repo}` : "current repository"}. Static analysis found ${actionable.length} problem(s). Fix them one at a time, most severe first, with a separate small commit for each.`,
    "",
    ...actionable.flatMap((p, i) => [
      `${i + 1}. [${p.severity}] ${p.title}`,
      `   Where: ${loc(p.where)}${p.routes && p.routes.length > 1 ? ` (${p.routes.length} routes)` : ""}`,
      `   Fix: ${p.fix[0]}`,
    ]),
    "",
    "For each one: read the code first and confirm it's real (skip it and say why if it isn't), make the smallest fix, add or update a test that proves it, and run the test suite before moving on.",
    ...GUARDRAILS.slice(1),
  ].join("\n");
}

/** Per commit: what it introduced that's still open, and a prompt to fix exactly that. */
export function buildCommitFixes(analysis: Pick<HistoryAnalysis, "head" | "commits" | "repo">, problems: RepoProblem[]): CommitFix[] {
  const open = new Map(problems.map((p) => [p.id, p]));
  const out: CommitFix[] = [];
  for (const c of analysis.commits) {
    if (c.delta.newFindings.length === 0) continue;
    const stillOpen = c.delta.newFindings.filter((id) => open.has(id) && open.get(id)!.introducedIn?.sha === c.sha);
    const fixedLater = c.delta.newFindings.filter((id) => !open.has(id));
    const fix: CommitFix = { sha: c.sha, open: stillOpen, fixedLater };
    if (stillOpen.length) {
      fix.prompt = [
        `You are working in the ${analysis.repo ? `repository ${analysis.repo}` : "current repository"}. Commit ${c.sha.slice(0, 7)} "${c.subject}" (${c.author}${c.ai ? `, written with ${c.ai.tool}` : ""}${c.landing?.pr ? `, PR #${c.landing.pr}` : ""}) introduced problems that are still in the code. Fix them without undoing what the commit was for.`,
        "",
        ...stillOpen.flatMap((id, i) => {
          const p = open.get(id)!;
          return [`${i + 1}. [${p.severity}] ${p.title} (${loc(p.where)})`, `   Why: ${p.why}`, ...p.fix.map((f) => `   - ${f}`)];
        }),
        "",
        `Start by reading the commit's diff (git show ${c.sha.slice(0, 12)}) to understand its intent.`,
        ...GUARDRAILS,
      ].join("\n");
    }
    out.push(fix);
  }
  return out;
}

export function buildReport(analysis: Pick<HistoryAnalysis, "head" | "commits" | "repo">, headFlows: RequestFlow[]): RepoReport {
  const problems = buildProblems(analysis, headFlows);
  return { repo: analysis.repo, problems, fixAllPrompt: fixAllPrompt(analysis.repo, problems), commits: buildCommitFixes(analysis, problems) };
}
