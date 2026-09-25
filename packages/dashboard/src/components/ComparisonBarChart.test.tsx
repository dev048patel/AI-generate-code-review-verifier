import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComparisonBarChart } from "./ComparisonBarChart";

describe("ComparisonBarChart", () => {
  it("renders a group label and value for each metric", () => {
    render(
      <ComparisonBarChart
        groups={[
          { label: "Precision", full: 97, baseline: 80 },
          { label: "Recall", full: 92, baseline: 61 },
        ]}
      />,
    );
    expect(screen.getByText("Precision")).toBeInTheDocument();
    expect(screen.getByText("Recall")).toBeInTheDocument();
    expect(screen.getByText("97")).toBeInTheDocument();
    expect(screen.getByText("92")).toBeInTheDocument();
  });

  it("renders a legend identifying both series", () => {
    render(<ComparisonBarChart groups={[{ label: "F1", full: 50, baseline: 40 }]} />);
    expect(screen.getByText("Full pipeline")).toBeInTheDocument();
    expect(screen.getByText("No-AI baseline (rules only)")).toBeInTheDocument();
  });

  it("has an accessible label on the chart svg", () => {
    render(<ComparisonBarChart groups={[{ label: "F1", full: 50, baseline: 40 }]} />);
    expect(screen.getByRole("img", { name: /comparison chart/i })).toBeInTheDocument();
  });
});
