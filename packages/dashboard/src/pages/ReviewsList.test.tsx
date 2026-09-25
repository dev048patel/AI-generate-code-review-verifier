import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReviewsList } from "./ReviewsList";
import type { ReviewResult } from "../types";

function mockReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    id: "r1",
    repo: "acme/widgets",
    prNumber: 5,
    headSha: "abc",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    isTrivial: false,
    trivialReasons: [],
    changedFunctions: [],
    generatedTests: [],
    trustScore: {
      score: 88,
      label: "trusted",
      components: { llmRisk: 90, mutationCoverage: 90, testHealth: 90, ruleFlags: 90 },
      evidence: [],
    },
    costUsd: 0.002,
    latencyMs: 1234,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReviewsList", () => {
  it("shows a loading state, then the review table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: [mockReview()] }) }),
    );

    render(
      <MemoryRouter>
        <ReviewsList />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Loading reviews/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("acme/widgets")).toBeInTheDocument());
    expect(screen.getByText("#5")).toBeInTheDocument();
  });

  it("shows an empty state when there are no reviews", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: [] }) }));

    render(
      <MemoryRouter>
        <ReviewsList />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/No reviews logged yet/)).toBeInTheDocument());
  });

  it("shows an error message when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
    );

    render(
      <MemoryRouter>
        <ReviewsList />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/Couldn't load reviews/)).toBeInTheDocument());
  });
});
