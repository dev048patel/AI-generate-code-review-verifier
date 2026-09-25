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
};
