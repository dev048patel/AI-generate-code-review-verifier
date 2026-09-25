import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryGitHubClient, listOpenPullRequests, RestGitHubClient } from "./githubClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RestGitHubClient", () => {
  function stubFetchForFetchPullRequest(calls: RequestInit[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(init);
        if (url.includes("/files")) {
          return { ok: true, json: async () => [] };
        }
        return {
          ok: true,
          json: async () => ({ title: "t", body: "d", head: { sha: "abc" }, user: { login: "octocat" }, html_url: "u" }),
          text: async () => "diff --git a/x b/x\n",
        };
      }),
    );
  }

  it("omits the Authorization header when constructed without a token", async () => {
    const calls: RequestInit[] = [];
    stubFetchForFetchPullRequest(calls);

    const client = new RestGitHubClient();
    await client.fetchPullRequest("acme", "widgets", 1);

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("includes a Bearer Authorization header when constructed with a token", async () => {
    const calls: RequestInit[] = [];
    stubFetchForFetchPullRequest(calls);

    const client = new RestGitHubClient("my-token");
    await client.fetchPullRequest("acme", "widgets", 1);

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-token");
  });

  it("no-ops upsertComment without throwing when no token is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new RestGitHubClient();
    await expect(client.upsertComment("acme", "widgets", 1, "marker", "body")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("listOpenPullRequests", () => {
  it("maps the GitHub API response into OpenPullRequestSummary objects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { number: 5, title: "Fix bug", user: { login: "octocat" }, updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/a/b/pull/5" },
        ],
      }),
    );

    const prs = await listOpenPullRequests("acme", "widgets");
    expect(prs).toEqual([
      { number: 5, title: "Fix bug", authorLogin: "octocat", updatedAt: "2026-01-01T00:00:00Z", htmlUrl: "https://github.com/a/b/pull/5" },
    ]);
  });

  it("throws a descriptive error when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" }));
    await expect(listOpenPullRequests("acme", "widgets")).rejects.toThrow(/404/);
  });
});

describe("InMemoryGitHubClient (unchanged upsert behavior)", () => {
  it("still records comments for tests that inject it directly", async () => {
    const client = new InMemoryGitHubClient({});
    await client.upsertComment("acme", "widgets", 1, "m1", "hello");
    expect(client.postedComments).toHaveLength(1);
  });
});
