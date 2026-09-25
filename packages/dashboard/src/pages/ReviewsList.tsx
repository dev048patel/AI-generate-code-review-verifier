import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { ReviewResult } from "../types";
import { TrustScoreBadge } from "../components/TrustScoreBadge";

export function ReviewsList() {
  const [reviews, setReviews] = useState<ReviewResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listReviews()
      .then((r) => setReviews(r.reviews))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div className="card">
        <p className="muted">Couldn't load reviews: {error}</p>
      </div>
    );
  }

  if (!reviews) {
    return (
      <div className="card">
        <span className="spinner" /> Loading reviews…
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="card empty-state">
        <div className="empty-state-icon">🛰️</div>
        <p>No reviews logged yet.</p>
        <p>
          Head to <Link to="/live">Live GitHub</Link> to scan a real repository, or{" "}
          <Link to="/try">Try it</Link> to run a seeded-bug example.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card-title">📋 Review log ({reviews.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Repo</th>
            <th>PR</th>
            <th>Trust score</th>
            <th>Findings</th>
            <th>Latency</th>
            <th>Cost</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => navigate(`/reviews/${r.id}`)}>
              <td className="mono">
                {r.repo}
                {r.isLive && (
                  <span className="badge live" style={{ marginLeft: 8 }}>
                    <span className="dot" /> LIVE
                  </span>
                )}
              </td>
              <td>
                <Link to={`/reviews/${r.id}`}>#{r.prNumber || "sim"}</Link>
              </td>
              <td>
                <TrustScoreBadge trustScore={r.trustScore} />
              </td>
              <td>{r.trustScore.evidence.length}</td>
              <td className="mono">{r.latencyMs}ms</td>
              <td className="mono">${r.costUsd.toFixed(4)}</td>
              <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
