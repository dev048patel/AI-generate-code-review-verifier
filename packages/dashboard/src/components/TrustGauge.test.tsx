import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrustGauge } from "./TrustGauge";
import type { TrustScoreBreakdown } from "../types";

function score(overrides: Partial<TrustScoreBreakdown> = {}): TrustScoreBreakdown {
  return {
    score: 82,
    label: "trusted",
    components: { llmRisk: 90, mutationCoverage: 80, testHealth: 85, ruleFlags: 90 },
    evidence: [],
    ...overrides,
  };
}

describe("TrustGauge", () => {
  it("renders the numeric score inside the gauge", () => {
    render(<TrustGauge trustScore={score()} />);
    expect(screen.getByText("82")).toBeInTheDocument();
  });

  it("shows the human label for a high-risk score", () => {
    render(<TrustGauge trustScore={score({ label: "high-risk", score: 20 })} />);
    expect(screen.getByText("HIGH RISK")).toBeInTheDocument();
  });

  it("has an accessible label describing the score", () => {
    render(<TrustGauge trustScore={score({ score: 65, label: "needs-review" })} />);
    expect(screen.getByRole("img", { name: /65 out of 100/i })).toBeInTheDocument();
  });
});
