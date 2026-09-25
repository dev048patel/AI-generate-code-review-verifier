import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { BenchmarkSummary } from "../types";
import { ComparisonBarChart } from "../components/ComparisonBarChart";
import { TrustScoreBadge } from "../components/TrustScoreBadge";

export function EvalReport() {
  const [summary, setSummary] = useState<BenchmarkSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getEvalReport()
      .then(setSummary)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div className="card empty-state">
        <p>No evaluation report available yet.</p>
        <p className="mono">npm run eval</p>
        <p className="muted">generates it from the seeded-bug fixtures in packages/eval-harness/fixtures.</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="card">
        <span className="spinner" /> Loading evaluation report…
      </div>
    );
  }

  const { aggregate, baseline } = summary;

  return (
    <div>
      <div className="card">
        <div className="topbar" style={{ marginBottom: 4, border: "none", paddingBottom: 0 }}>
          <h2 style={{ margin: 0 }}>🏆 Seeded-bug benchmark</h2>
          <span className="muted mono">provider: {summary.provider}</span>
        </div>
        <p className="muted">
          {summary.cases.length} fixtures · run {new Date(summary.createdAt).toLocaleString()}
        </p>

        <ComparisonBarChart
          groups={[
            { label: "Precision", full: aggregate.precision * 100, baseline: baseline.precision * 100 },
            { label: "Recall", full: aggregate.recall * 100, baseline: baseline.recall * 100 },
            { label: "F1 × 100", full: aggregate.f1 * 100, baseline: baseline.f1 * 100 },
          ]}
        />
      </div>

      <div className="card">
        <div className="grid-2">
          <Stat label="Seeded bugs detected" value={`${aggregate.detectedBugs} / ${aggregate.totalSeededBugs}`} />
          <Stat label="False positives" value={String(aggregate.falsePositives)} />
          <Stat label="Median review latency" value={`${aggregate.medianLatencyMs.toFixed(0)}ms`} />
          <Stat label="Total cost (all fixtures)" value={`$${aggregate.totalCostUsd.toFixed(4)}`} />
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">📊 Per-fixture results</h3>
        <table>
          <thead>
            <tr>
              <th>Fixture</th>
              <th>Trust score</th>
              <th>Detected</th>
              <th>Missed</th>
              <th>False positives</th>
            </tr>
          </thead>
          <tbody>
            {summary.cases.map((c) => (
              <tr key={c.caseId}>
                <td>
                  <Link to={`/reviews/${c.review.id}`} className="mono">
                    {c.caseId}
                  </Link>
                </td>
                <td>
                  <TrustScoreBadge trustScore={c.review.trustScore} />
                </td>
                <td>{c.truePositives.length}</td>
                <td className={c.falseNegatives.length > 0 ? "mono" : "mono muted"}>{c.falseNegatives.length}</td>
                <td className={c.falsePositives > 0 ? "mono" : "mono muted"}>{c.falsePositives}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
