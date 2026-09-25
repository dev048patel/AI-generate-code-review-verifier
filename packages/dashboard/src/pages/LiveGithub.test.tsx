import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { LiveGithub } from "./LiveGithub";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LiveGithub", () => {
  it("lists real open PRs after scanning a repo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pullRequests: [
            { number: 42, title: "Fix the thing", authorLogin: "octocat", updatedAt: "2026-01-01T00:00:00Z", htmlUrl: "https://github.com/a/b/pull/42" },
          ],
        }),
      }),
    );

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LiveGithub />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /scan repo/i }));
    await waitFor(() => expect(screen.getByText(/Fix the thing/)).toBeInTheDocument());
    expect(screen.getByText(/octocat/)).toBeInTheDocument();
  });

  it("shows an empty state when a repo has no open PRs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pullRequests: [] }) }));

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LiveGithub />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /scan repo/i }));
    await waitFor(() => expect(screen.getByText(/No open PRs found/)).toBeInTheDocument());
  });

  it("shows an error when the repo input isn't valid owner/name", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LiveGithub />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText(/Repository/i);
    await user.clear(input);
    await user.type(input, "not-a-valid-repo");
    await user.click(screen.getByRole("button", { name: /scan repo/i }));

    expect(await screen.findByText(/Enter a repo as/i)).toBeInTheDocument();
  });

  it("surfaces a friendly error from the API on scan failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "rate limited" }) }));

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LiveGithub />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /scan repo/i }));
    await waitFor(() => expect(screen.getByText(/rate limited/)).toBeInTheDocument());
  });
});
