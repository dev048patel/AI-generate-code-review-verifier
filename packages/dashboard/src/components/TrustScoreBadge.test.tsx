import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrustScoreBadge, SeverityTag } from "./TrustScoreBadge";
import type { TrustScoreBreakdown } from "../types";

function score(overrides: Partial<TrustScoreBreakdown> = {}): TrustScoreBreakdown {
  return {
    score: 90,
    label: "trusted",
    components: { llmRisk: 90, mutationCoverage: 90, testHealth: 90, ruleFlags: 90 },
    evidence: [],
    ...overrides,
  };
}

describe("TrustScoreBadge", () => {
  it("renders the numeric score and a human label", () => {
    render(<TrustScoreBadge trustScore={score()} />);
    expect(screen.getByText(/90/)).toBeInTheDocument();
    expect(screen.getByText(/Trusted/)).toBeInTheDocument();
  });

  it("applies the high-risk class for a high-risk score", () => {
    const { container } = render(<TrustScoreBadge trustScore={score({ label: "high-risk", score: 30 })} />);
    expect(container.querySelector(".badge.high-risk")).toBeInTheDocument();
  });

  it("applies the needs-review class for a needs-review score", () => {
    const { container } = render(<TrustScoreBadge trustScore={score({ label: "needs-review", score: 65 })} />);
    expect(container.querySelector(".badge.needs-review")).toBeInTheDocument();
  });
});

describe("SeverityTag", () => {
  it("renders the severity text and class", () => {
    const { container } = render(<SeverityTag severity="critical" />);
    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(container.querySelector(".severity.critical")).toBeInTheDocument();
  });
});
