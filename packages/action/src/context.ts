import { readFile } from "node:fs/promises";

export interface PullRequestTarget {
  owner: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
  htmlUrl?: string;
  author?: string;
  /** Head branch lives in a different repository (a fork). */
  isFork: boolean;
}

interface PullRequestPayload {
  number: number;
  title: string;
  body: string | null;
  html_url?: string;
  user?: { login: string } | null;
  base: { sha: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}

interface EventPayload {
  pull_request?: PullRequestPayload;
  workflow_run?: { head_sha: string; event: string; conclusion: string | null };
  repository?: { full_name: string };
}

export async function readEvent(env: NodeJS.ProcessEnv = process.env): Promise<{ name: string; payload: EventPayload }> {
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_EVENT_NAME) throw new Error("Not running inside GitHub Actions (GITHUB_EVENT_PATH unset)");
  return { name: env.GITHUB_EVENT_NAME, payload: JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf-8")) as EventPayload };
}

export function fromPullRequest(pr: PullRequestPayload): PullRequestTarget {
  const [owner, repo] = pr.base.repo.full_name.split("/") as [string, string];
  return {
    owner,
    repo,
    prNumber: pr.number,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    title: pr.title,
    body: pr.body ?? "",
    htmlUrl: pr.html_url,
    author: pr.user?.login,
    isFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
  };
}

/**
 * Resolves which PR to report on.
 *  - pull_request / pull_request_target: straight from the event.
 *  - workflow_run (the fork-safe reporting workflow): the PR number comes from
 *    the execute job's artifact, which the PR's own code could have written --
 *    so it's only trusted after the API confirms that PR's head is exactly the
 *    commit the triggering run built.
 */
export async function resolvePullRequest(options: {
  event: { name: string; payload: EventPayload };
  artifactPrNumber?: number;
  api: GitHubApi;
  repoFullName: string;
}): Promise<PullRequestTarget> {
  const { event } = options;
  if (event.payload.pull_request) return fromPullRequest(event.payload.pull_request);

  if (event.name === "workflow_run" && event.payload.workflow_run) {
    if (!options.artifactPrNumber) throw new Error("workflow_run: the execution artifact carries no PR number");
    const [owner, repo] = options.repoFullName.split("/") as [string, string];
    const pr = await options.api.getPull(owner, repo, options.artifactPrNumber);
    if (pr.head.sha !== event.payload.workflow_run.head_sha) {
      throw new Error(
        `PR #${options.artifactPrNumber} is at ${pr.head.sha}, but the triggering run built ${event.payload.workflow_run.head_sha}; refusing to report.`,
      );
    }
    return fromPullRequest(pr);
  }

  throw new Error(`Unsupported event "${event.name}": run on pull_request, or on workflow_run for the fork-safe setup.`);
}

/** The few GitHub REST calls the Action makes, with the job's token. */
export class GitHubApi {
  constructor(
    private readonly token: string | undefined,
    private readonly baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  ) {}

  get canWrite(): boolean {
    return Boolean(this.token);
  }

  getPull(owner: string, repo: string, number: number): Promise<PullRequestPayload> {
    return this.request<PullRequestPayload>("GET", `/repos/${owner}/${repo}/pulls/${number}`);
  }

  /** Creates or updates the single comment carrying `marker`, so re-runs edit rather than spam. */
  async upsertComment(owner: string, repo: string, number: number, marker: string, body: string): Promise<void> {
    const tag = `<!-- acrv:${marker} -->`;
    const full = `${tag}\n${body}`;
    for (let page = 1; page <= 10; page++) {
      const comments = await this.request<Array<{ id: number; body?: string }>>(
        "GET",
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      const existing = comments.find((c) => c.body?.includes(tag));
      if (existing) {
        await this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body: full });
        return;
      }
      if (comments.length < 100) break;
    }
    await this.request("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body: full });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}
