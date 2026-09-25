import type { Finding, ReviewResult } from "@acrv/core";

export interface PullRequestContext {
  repo: string; // "owner/name"
  prNumber: number;
  headSha: string;
  /** Tip of the base branch as GitHub currently sees it. */
  baseSha?: string;
  title: string;
  description: string;
  diffText: string;
  authorLogin?: string;
  htmlUrl?: string;
  /** Full content of every non-binary changed file at the PR's head commit, keyed by its diff path. */
  afterFileContents: Record<string, string>;
}

/**
 * Everything the review pipeline needs from GitHub, behind an interface so
 * the webhook handler and REST "simulate" endpoint can be tested without a
 * live GitHub App installation or network access.
 */
export interface GitHubClient {
  fetchPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestContext>;
  /**
   * Creates or updates the bot's comment on a PR, keyed by `marker` (e.g. the
   * review id) rather than always creating a new one. This makes the call
   * idempotent and therefore safe to retry, per the Builders' Library
   * guidance the project brief calls out: retry only idempotent operations.
   *
   * With no write-capable token configured, implementations should no-op
   * (read-only mode) rather than throw -- browsing and analyzing real public
   * repos should never require write access.
   */
  upsertComment(owner: string, repo: string, prNumber: number, marker: string, body: string): Promise<void>;
  /** Starts an in-progress check run on the commit; returns its id (undefined when the client can't write checks). */
  createCheckRun?(owner: string, repo: string, headSha: string): Promise<number | undefined>;
  completeCheckRun?(owner: string, repo: string, checkRunId: number, outcome: CheckRunOutcome): Promise<void>;
}

export interface CheckRunOutcome {
  conclusion: "success" | "neutral" | "failure" | "skipped" | "cancelled";
  title: string;
  summary: string;
  findings?: Finding[];
}

export const CHECK_RUN_NAME = "AI Code Review Verifier";

/** Maps a finished review to a check-run result. Only `failBelow` ever makes the check fail -- blocking merges is opt-in. */
export function checkRunOutcome(review: ReviewResult, summary: string, failBelow = 0): CheckRunOutcome {
  const { score, label } = review.trustScore;
  return {
    conclusion: score < failBelow ? "failure" : label === "trusted" ? "success" : "neutral",
    title: `Trust score ${score}/100 (${label})`,
    summary,
    findings: review.trustScore.evidence,
  };
}

const LEVEL: Record<Finding["severity"], "failure" | "warning" | "notice"> = {
  critical: "failure",
  high: "failure",
  medium: "warning",
  low: "notice",
  none: "notice",
};

/** Check-run annotations (GitHub accepts at most 50 per request); line-less findings stay in the summary. */
export function toAnnotations(findings: Finding[]): Array<Record<string, unknown>> {
  return findings
    .filter((f) => f.line !== undefined)
    .slice(0, 50)
    .map((f) => ({
      path: f.file,
      start_line: f.line,
      end_line: f.line,
      annotation_level: LEVEL[f.severity],
      title: f.title.slice(0, 255),
      message: (f.evidence ? `${f.detail}\n\n${f.evidence}` : f.detail).slice(0, 64_000),
    }));
}

function withMarker(marker: string, body: string): string {
  return `<!-- acrv:${marker} -->\n${body}`;
}

const GITHUB_API = "https://api.github.com";

export interface OpenPullRequestSummary {
  number: number;
  title: string;
  authorLogin: string;
  updatedAt: string;
  htmlUrl: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/**
 * Lists a real repo's most recently updated open pull requests, for the
 * dashboard's "Live GitHub" picker. Works unauthenticated against any public
 * repo (subject to GitHub's lower unauthenticated rate limit); pass a token
 * for higher limits or to reach private repos.
 */
export async function listOpenPullRequests(
  owner: string,
  repo: string,
  token?: string,
): Promise<OpenPullRequestSummary[]> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=15`, {
    headers: authHeaders("application/vnd.github+json", token),
  });
  if (!res.ok) {
    throw new Error(`GitHub list PRs failed: ${res.status} ${await res.text()}`);
  }
  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    user: { login: string } | null;
    updated_at: string;
    html_url: string;
  }>;
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    authorLogin: pr.user?.login ?? "unknown",
    updatedAt: pr.updated_at,
    htmlUrl: pr.html_url,
  }));
}

function authHeaders(accept: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Real implementation backed by the public GitHub REST API. Works
 * unauthenticated (read-only, subject to GitHub's public rate limit) for any
 * public repo; pass a token for higher limits, private repos, or the ability
 * to post/update PR comments.
 */
export class RestGitHubClient implements GitHubClient {
  constructor(private readonly token?: string) {}

  async fetchPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestContext> {
    const pr = await this.get<{
      title: string;
      body: string | null;
      head: { sha: string };
      base?: { sha: string };
      user: { login: string } | null;
      html_url: string;
    }>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    const diffText = await this.getRaw(`/repos/${owner}/${repo}/pulls/${prNumber}`, "application/vnd.github.diff");
    const files = await this.get<Array<{ filename: string; status: string }>>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files`,
    );

    const afterFileContents: Record<string, string> = {};
    for (const file of files) {
      if (file.status === "removed") continue;
      if (!/\.(ts|tsx|js|jsx|md)$/.test(file.filename)) continue;
      try {
        const content = await this.get<{ content: string; encoding: string }>(
          `/repos/${owner}/${repo}/contents/${encodeURIComponent(file.filename)}?ref=${pr.head.sha}`,
        );
        afterFileContents[file.filename] = Buffer.from(content.content, content.encoding as BufferEncoding).toString(
          "utf-8",
        );
      } catch {
        // File may have been deleted between listing and fetch, or be too large; skip it.
      }
    }

    return {
      repo: `${owner}/${repo}`,
      prNumber,
      headSha: pr.head.sha,
      baseSha: pr.base?.sha,
      title: pr.title,
      description: pr.body ?? "",
      diffText,
      authorLogin: pr.user?.login,
      htmlUrl: pr.html_url,
      afterFileContents,
    };
  }

  async upsertComment(owner: string, repo: string, prNumber: number, marker: string, body: string): Promise<void> {
    if (!this.token) {
      console.warn(
        `[acrv] No GITHUB_TOKEN configured -- read-only mode, skipping comment on ${owner}/${repo}#${prNumber}.`,
      );
      return;
    }
    const markerTag = `<!-- acrv:${marker} -->`;
    const fullBody = withMarker(marker, body);
    const comments = await this.get<Array<{ id: number; body: string }>>(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    );
    const existing = comments.find((c) => c.body.includes(markerTag));

    const path = existing
      ? `/repos/${owner}/${repo}/issues/comments/${existing.id}`
      : `/repos/${owner}/${repo}/issues/${prNumber}/comments`;
    const res = await fetch(`${GITHUB_API}${path}`, {
      method: existing ? "PATCH" : "POST",
      headers: this.headers("application/vnd.github+json"),
      body: JSON.stringify({ body: fullBody }),
    });
    if (!res.ok) {
      throw new Error(`GitHub upsertComment failed: ${res.status} ${await res.text()}`);
    }
  }

  async createCheckRun(owner: string, repo: string, headSha: string): Promise<number | undefined> {
    if (!this.token) return undefined;
    const run = await this.send<{ id: number }>("POST", `/repos/${owner}/${repo}/check-runs`, {
      name: CHECK_RUN_NAME,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    });
    return run.id;
  }

  async completeCheckRun(owner: string, repo: string, checkRunId: number, outcome: CheckRunOutcome): Promise<void> {
    if (!this.token) return;
    await this.send("PATCH", `/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
      status: "completed",
      conclusion: outcome.conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: outcome.title.slice(0, 255),
        summary: outcome.summary.slice(0, 65_000),
        annotations: toAnnotations(outcome.findings ?? []),
      },
    });
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<T> {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: { ...this.headers("application/vnd.github+json"), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  private headers(accept: string): Record<string, string> {
    return authHeaders(accept, this.token);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${GITHUB_API}${path}`, { headers: this.headers("application/vnd.github+json") });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async getRaw(path: string, accept: string): Promise<string> {
    const res = await fetch(`${GITHUB_API}${path}`, { headers: this.headers(accept) });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.text();
  }
}

/**
 * In-memory implementation for local development, the eval harness, and the
 * dashboard's "simulate a PR" demo feature -- lets the whole pipeline run
 * end-to-end without a real GitHub App installation.
 */
export class InMemoryGitHubClient implements GitHubClient {
  public readonly postedComments: Array<{ owner: string; repo: string; prNumber: number; marker: string; body: string }> =
    [];
  public readonly checkRuns: Array<{ id: number; owner: string; repo: string; headSha: string; outcome?: CheckRunOutcome }> = [];

  constructor(private readonly pullRequests: Record<string, PullRequestContext>) {}

  async fetchPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestContext> {
    const key = `${owner}/${repo}#${prNumber}`;
    const found = this.pullRequests[key];
    if (!found) throw new Error(`No fixture registered for ${key}`);
    return found;
  }

  async upsertComment(owner: string, repo: string, prNumber: number, marker: string, body: string): Promise<void> {
    const existing = this.postedComments.find(
      (c) => c.owner === owner && c.repo === repo && c.prNumber === prNumber && c.marker === marker,
    );
    if (existing) {
      existing.body = withMarker(marker, body);
    } else {
      this.postedComments.push({ owner, repo, prNumber, marker, body: withMarker(marker, body) });
    }
  }

  async createCheckRun(owner: string, repo: string, headSha: string): Promise<number> {
    const id = this.checkRuns.length + 1;
    this.checkRuns.push({ id, owner, repo, headSha });
    return id;
  }

  async completeCheckRun(_owner: string, _repo: string, checkRunId: number, outcome: CheckRunOutcome): Promise<void> {
    const run = this.checkRuns.find((r) => r.id === checkRunId);
    if (run) run.outcome = outcome;
  }
}
