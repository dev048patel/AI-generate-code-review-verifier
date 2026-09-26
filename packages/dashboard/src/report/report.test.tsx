import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { CommitPoint, HistoryAnalysis, RepoReport } from "../atlasTypes";
import { PromptBox } from "../components/report/PromptBox";
import { headline, Report, ReportLanding } from "../pages/Report";
import { parseRepoInput } from "./parseInput";
import { DEFAULT_ASSUMPTIONS, formatTokens, formatUsd, MODEL_PRICES, pullRequests, summarize, usageOfChars, type Assumptions } from "./usage";

const metrics = { modules: 3, testModules: 1, loc: 120, importEdges: 2, packages: 1, routes: 2, authRoutes: 1, unprotectedAuthRoutes: 1, brokenImports: 0, unusedModules: 0, cycles: 0 };
const commit = (sha: string, over: Partial<CommitPoint> = {}): CommitPoint => ({
  sha: sha.padEnd(40, "0"),
  author: "Ada",
  date: "2026-09-01T10:00:00Z",
  subject: `commit ${sha}`,
  metrics,
  churn: { added: 10, deleted: 2, files: 1 },
  shortLivedLines: 0,
  shortLivedChars: 0,
  chars: { added: 400_000, deleted: 0 },
  landing: { via: "push" },
  delta: { modulesAdded: 0, modulesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, newFindings: [], resolvedFindings: [] },
  ...over,
});

const commits = [
  commit("a", { subject: "init" }),
  commit("b", { ai: { tool: "Claude Code", evidence: "Generated with Claude Code" }, landing: { via: "pr", pr: 7, title: "Add login" }, shortLivedChars: 40_000, delta: { modulesAdded: 0, modulesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, newFindings: ["auth-route-no-rate-limit:POST /login"], resolvedFindings: [] } }),
  commit("c", { author: "Bo" }),
  commit("d", { bot: "dependabot", chars: { added: 999_999, deleted: 0 } }),
];

describe("cost model", () => {
  it("prices written and read tokens with the model's rates", () => {
    const a: Assumptions = { ...DEFAULT_ASSUMPTIONS, model: MODEL_PRICES[0]!, charsPerToken: 4, readPerWritten: 20, cachedShare: 0.8 };
    const u = usageOfChars(4_000_000, a); // 1M tokens written, 20M read
    expect(u.written).toBe(1_000_000);
    expect(u.read).toBe(20_000_000);
    // 1M × $20 + 20M × (0.8 × $0.20 + 0.2 × $4) = $20 + $19.20
    expect(u.usd).toBeCloseTo(39.2, 6);
  });

  it("counts only AI-marked commits by default, never bots, and everything under the upper bound", () => {
    const marked = summarize(commits, DEFAULT_ASSUMPTIONS);
    expect(marked.aiCommits).toBe(1);
    expect(marked.countedCommits).toBe(1);
    expect(marked.botCommits).toBe(1);
    expect(marked.total.written).toBe(100_000);
    expect(marked.wasted.written).toBe(10_000);
    expect(marked.byTool.map((g) => g.key)).toEqual(["Claude Code"]);
    expect(marked.series.map((p) => [p.aiWritten, p.otherWritten])).toEqual([[100_000, 0], [0, 0], [0, 0]]);

    const all = summarize(commits, { ...DEFAULT_ASSUMPTIONS, scope: "all" });
    expect(all.countedCommits).toBe(2); // b and c; the first commit is the baseline, d is a bot
    expect(all.total.written).toBe(200_000);
    expect(all.byTool.map((g) => g.key)).toEqual(["Claude Code", "Not marked"]);
    expect(all.series[all.series.length - 1]!.cumulativeUsd).toBeCloseTo(all.total.usd, 9);
  });

  it("lists merged pull requests newest first with their cost and problems", () => {
    expect(pullRequests(commits, DEFAULT_ASSUMPTIONS)).toEqual([expect.objectContaining({ number: 7, title: "Add login", ai: "Claude Code", introduced: 1 })]);
  });

  it("formats money and tokens for people", () => {
    expect([formatUsd(0), formatUsd(0.004), formatUsd(3.456), formatUsd(1234.5)]).toEqual(["$0", "<$0.01", "$3.46", "$1,235"]);
    expect([formatTokens(950), formatTokens(38_800), formatTokens(2_500_000)]).toEqual(["950", "38.8K", "2.5M"]);
  });
});

describe("parseRepoInput", () => {
  it("accepts any way of pointing at a GitHub repo", () => {
    expect(parseRepoInput("https://github.com/acme/api")).toEqual({ repo: "acme/api" });
    expect(parseRepoInput("github.com/acme/api.git")).toEqual({ repo: "acme/api" });
    expect(parseRepoInput("git@github.com:acme/api.git")).toEqual({ repo: "acme/api" });
    expect(parseRepoInput("acme/api")).toEqual({ repo: "acme/api" });
    expect(parseRepoInput("https://github.com/acme/api/pull/42/files")).toEqual({ repo: "acme/api", pr: 42 });
    expect(parseRepoInput("https://github.com/acme/api/commit/ABCDEF1234")).toEqual({ repo: "acme/api", sha: "abcdef1234" });
    expect(parseRepoInput("https://github.com/acme/api/blob/main/src/app.ts")).toEqual({ repo: "acme/api" });
  });

  it("rejects everything else", () => {
    for (const bad of ["", "acme", "https://gitlab.com/acme/api", "https://github.com/settings/profile", "javascript:alert(1)", "a/b/c", "../../etc"]) {
      expect(parseRepoInput(bad)).toBeUndefined();
    }
  });
});

describe("PromptBox", () => {
  it("copies the prompt and says so", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PromptBox prompt="Fix the rate limit" />);
    fireEvent.click(screen.getByRole("button", { name: "▸ Prompt to fix it" }));
    expect(screen.getByText("Fix the rate limit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy: Prompt to fix it" }));
    await waitFor(() => expect(screen.getByText("✓ Copied")).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("Fix the rate limit");
  });
});

const analysis: HistoryAnalysis = {
  repo: "acme/api",
  commits,
  head: { nodes: [], edges: [], findings: [], metrics },
  hotspots: [{ file: "src/app.ts", commits: 3, churn: 40, loc: 50 }],
  waste: { shortLivedLines: 12, addedLines: 30, estimatedTokens: 10_000, windowCommits: 5 },
  recommendations: [{ id: "rec:rate", priority: "high", title: "Add rate limiting to POST /login", detail: "…" }],
  truncated: false,
};

const report: RepoReport = {
  repo: "acme/api",
  problems: [
    {
      id: "auth-route-no-rate-limit:POST /login",
      kind: "auth-route-no-rate-limit",
      severity: "high",
      title: "POST /login has no rate limiting",
      why: "Passwords can be guessed.",
      fix: ["Add a limiter."],
      where: { file: "src/app.ts", line: 3 },
      introducedIn: { sha: commits[1]!.sha, subject: "commit b", author: "Ada", date: "2026-09-01", ai: "Claude Code", pr: 7 },
      prompt: "You are working in the repository acme/api. Fix POST /login rate limiting.",
    },
  ],
  fixAllPrompt: "Fix all 1 problems",
  commits: [{ sha: commits[1]!.sha, open: ["auth-route-no-rate-limit:POST /login"], fixedLater: [], prompt: "Fix what b broke" }],
};

function mockApi(opts: { analyzed: boolean }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/atlas/analyze") return Response.json({ job: { repo: "acme/api", status: "running", progress: { done: 0, total: 3 } } });
      if (url.endsWith("/report")) return Response.json(report);
      if (url.includes("/pulls/")) return Response.json({ error: "GitHub PR lookup failed: 404" }, { status: 502 });
      if (url.includes("/architecture")) return Response.json({ components: [], edges: [], stories: [] });
      if (url === "/api/atlas/acme/api") {
        return opts.analyzed || calls.some((c) => c.startsWith("POST"))
          ? Response.json({ job: { repo: "acme/api", status: "done", progress: { done: 3, total: 3 } }, analysis })
          : Response.json({});
      }
      return Response.json({});
    }),
  );
  return calls;
}

function renderReport(path = "/r/acme/api") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r" element={<ReportLanding />} />
        <Route path="/r/:owner/:name" element={<Report />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Report page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes from one pasted link to the report", async () => {
    mockApi({ analyzed: true });
    renderReport("/r");
    fireEvent.change(screen.getByLabelText("GitHub link"), { target: { value: "https://github.com/acme/api/pull/7" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByRole("heading", { name: "Pull request #7: what it changes" })).toBeInTheDocument();
    // A PR the server can't look up shows the reason instead of breaking the page.
    expect(await screen.findByText(/GitHub PR lookup failed: 404/)).toBeInTheDocument();
  });

  it("opens an existing analysis without starting (and paying for) a new one", async () => {
    const calls = mockApi({ analyzed: true });
    renderReport();
    expect(await screen.findByText(/acme\/api: 3 commits analyzed\. 1 \(33%\) were marked as written with Claude Code/)).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });

  it("starts the analysis when there isn't one, then shows every section", async () => {
    const calls = mockApi({ analyzed: false });
    renderReport();
    await screen.findByText(/were marked as written with Claude Code/);
    expect(calls).toContain("POST /api/atlas/analyze");
    const rail = screen.getByRole("navigation", { name: "Report sections" });
    expect(within(rail).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "acme/api", "Overview", "AI & spend", "Evolution", "Commits4", "PRs & pushes1", "Architecture", "Problems & fixes1", "People", "Hotspots", "Open in explorer →",
    ]);
    // KPIs, the problem with its prompt, the commit that caused it, and the PR table.
    expect(screen.getAllByText("Est. AI cost")[0]!.nextSibling!.textContent).toMatch(/^\$/);
    const problem = await screen.findByRole("article", { name: "POST /login has no rate limiting" });
    expect(within(problem).getByText(/by Ada with Claude Code \(PR #7\)/)).toBeInTheDocument();
    expect(within(problem).getByRole("button", { name: "Copy: Prompt to fix it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy: One prompt to fix all 1 problems, most severe first" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#7" }).getAttribute("href")).toBe("https://github.com/acme/api/pull/7");
  });

  it("walks a commit's story, including the prompt to fix what it broke", async () => {
    mockApi({ analyzed: true });
    renderReport(`/r/acme/api?sha=${commits[1]!.sha}`);
    const detail = await screen.findByRole("article", { name: `Commit ${commits[1]!.sha.slice(0, 7)}` });
    expect(within(detail).getByText("Claude Code")).toBeInTheDocument();
    expect(within(detail).getByText("Fix what b broke")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /AI-written/ }));
    const rows = screen.getAllByRole("button").filter((b) => b.classList.contains("commit-row"));
    expect(rows.map((r) => r.querySelector(".commit-subject")!.textContent)).toEqual(["commit b"]);
  });

  it("switches to the upper-bound estimate when nothing is marked as AI-written", async () => {
    mockApi({ analyzed: true });
    const noAi = commits.map((c) => ({ ...c, ai: undefined }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/report")
          ? Response.json(report)
          : url.includes("/architecture")
            ? Response.json({ components: [], edges: [], stories: [] })
            : Response.json({ job: { status: "done", progress: { done: 3, total: 3 } }, analysis: { ...analysis, commits: noAi } }),
      ),
    );
    renderReport();
    fireEvent.click(await screen.findByRole("button", { name: "Estimate as if every commit were AI-written (upper bound)" }));
    expect(screen.getByRole("img", { name: "Estimated tokens written per commit" })).toBeInTheDocument();
  });
});

describe("headline", () => {
  it("says what matters most in one sentence", () => {
    expect(headline("acme/api", analysis, 1, ["Claude Code"], report.problems, DEFAULT_ASSUMPTIONS, 2.5)).toBe(
      `acme/api: 3 commits analyzed. 1 (33%) were marked as written with Claude Code, roughly $2.50 at Claude Opus 5.5 prices. Most urgent: POST /login has no rate limiting, introduced in ${commits[1]!.sha.slice(0, 7)} (Claude Code).`,
    );
  });
});
