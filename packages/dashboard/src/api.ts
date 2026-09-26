import type { Architecture, AtlasJob, CompareResult, HistoryAnalysis, RepoGraph, RequestFlow } from "./atlasTypes";
import type { BenchmarkSummary, FixtureSummary, OpenPullRequestSummary, ReviewResult } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Me {
  login: string | null;
  authRequired: boolean;
  demoEndpoints: boolean;
  repoCount?: number;
}

export const api = {
  /** null when the server requires sign-in and there is no session. */
  me: async (): Promise<Me | null> => {
    const res = await fetch("/auth/me");
    if (res.status === 401) return null;
    return json<Me>(res);
  },

  logout: () => fetch("/auth/logout", { method: "POST" }),

  listReviews: (repo?: string) =>
    fetch(`/api/reviews${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`).then((r) =>
      json<{ reviews: ReviewResult[] }>(r),
    ),

  getReview: (id: string) => fetch(`/api/reviews/${encodeURIComponent(id)}`).then((r) => json<{ review: ReviewResult }>(r)),

  getEvalReport: () => fetch("/api/eval-report").then((r) => json<BenchmarkSummary>(r)),

  listFixtures: () => fetch("/api/fixtures").then((r) => json<{ fixtures: FixtureSummary[] }>(r)),

  getFixtureDiff: (id: string) =>
    fetch(`/api/fixtures/${encodeURIComponent(id)}/diff`).then((r) =>
      json<{ prTitle: string; prDescription: string; diffText: string; afterFileContents: Record<string, string> }>(r),
    ),

  runFixtureReview: (id: string) =>
    fetch(`/api/fixtures/${encodeURIComponent(id)}/review`, { method: "POST" }).then((r) =>
      json<{ review: ReviewResult }>(r),
    ),

  listOpenPullRequests: (owner: string, repo: string) =>
    fetch(`/api/live/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`).then((r) =>
      json<{ pullRequests: OpenPullRequestSummary[] }>(r),
    ),

  runLiveReview: (owner: string, repo: string, prNumber: number) =>
    fetch("/api/live-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, prNumber }),
    }).then((r) => json<{ review: ReviewResult }>(r)),

  simulateDiff: (input: {
    repo: string;
    prTitle: string;
    prDescription: string;
    diffText: string;
    afterFileContents: Record<string, string>;
  }) =>
    fetch("/api/simulate-diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ review: ReviewResult }>(r)),

  atlasAnalyze: (repo: string, maxCommits: number) =>
    fetch("/api/atlas/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, maxCommits }),
    }).then((r) => json<{ job: AtlasJob }>(r)),

  atlasStatus: (repo: string) =>
    fetch(`/api/atlas/${repoPath(repo)}`).then((r) => json<{ job?: AtlasJob; analysis?: HistoryAnalysis }>(r)),

  atlasGraph: (repo: string, ref: string) =>
    fetch(`/api/atlas/${repoPath(repo)}/graph?ref=${encodeURIComponent(ref)}`).then((r) => json<RepoGraph>(r)),

  atlasFlows: (repo: string, ref = "HEAD") =>
    fetch(`/api/atlas/${repoPath(repo)}/flows?ref=${encodeURIComponent(ref)}`).then((r) => json<RequestFlow[]>(r)),

  atlasArchitecture: (repo: string, ref = "HEAD") =>
    fetch(`/api/atlas/${repoPath(repo)}/architecture?ref=${encodeURIComponent(ref)}`).then((r) => json<Architecture>(r)),

  atlasCompare: (repo: string, from: string, to: string) =>
    fetch(`/api/atlas/${repoPath(repo)}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) =>
      json<CompareResult>(r),
    ),

  atlasPullRequest: (repo: string, prNumber: number) =>
    fetch(`/api/atlas/${repoPath(repo)}/pulls/${prNumber}?graphs=1`).then((r) =>
      json<CompareResult & { base: string; head: string }>(r),
    ),

  /** Server-sent events stream of the live runtime view. */
  atlasRuntimeUrl: (repo: string) => `/api/atlas/${repoPath(repo)}/runtime/stream`,
};

function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}
