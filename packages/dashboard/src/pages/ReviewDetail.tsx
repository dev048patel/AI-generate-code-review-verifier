import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { ReviewResult } from "../types";
import { SeverityTag } from "../components/TrustScoreBadge";
import { TrustGauge } from "../components/TrustGauge";

export function ReviewDetail() {
  const { id } = useParams<{ id: string }>();
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setReview(null);
    setError(null);
    api
      .getReview(id)
      .then((r) => setReview(r.review))
      .catch((e) => setError(String(e)));
  }, [id]);

  if (error) {
    return (
      <div className="card">
        <p className="muted">Couldn't load this review: {error}</p>
        <Link to="/">&larr; Back to reviews</Link>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="card">
        <span className="spinner" /> Loading review…
      </div>
    );
  }

  return (
    <div>
      <p>
        <Link to="/">&larr; Back to reviews</Link>
      </p>

      <div className="card">
        <div className="topbar" style={{ marginBottom: 8, border: "none", paddingBottom: 0 }}>
          <div>
            <h2 style={{ margin: "0 0 4px" }} className="mono">
              {review.repo} #{review.prNumber || "sim"}
              {review.isLive && (
                <span className="badge live" style={{ marginLeft: 10 }}>
                  <span className="dot" /> LIVE
                </span>
              )}
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              {new Date(review.createdAt).toLocaleString()} · {review.latencyMs}ms · ${review.costUsd.toFixed(4)}
              {review.prAuthor && <> · by {review.prAuthor}</>}
              {review.prUrl && (
                <>
                  {" "}
                  ·{" "}
                  <a href={review.prUrl} target="_blank" rel="noreferrer">
                    View on GitHub ↗
                  </a>
                </>
              )}
            </p>
          </div>
          <TrustGauge trustScore={review.trustScore} />
        </div>

        {review.isTrivial ? (
          <p className="muted">Trivial PR — skipped LLM analysis. Reasons: {review.trivialReasons.join("; ")}</p>
        ) : (
          <>
            {review.risk && (
              <>
                <p>
                  <strong>Intent:</strong> {review.risk.intent}
                </p>
                <p className="muted">{review.risk.summary}</p>
              </>
            )}
          </>
        )}
      </div>

      {!review.isTrivial && (
        <div className="card">
          <h3 className="card-title">⚙️ Score breakdown</h3>
          <div className="grid-2">
            <ScoreStat label="LLM risk analysis" value={review.trustScore.components.llmRisk} />
            <ScoreStat label="Mutation-verified coverage" value={review.trustScore.components.mutationCoverage} />
            <ScoreStat label="Generated-test health" value={review.trustScore.components.testHealth} />
            <ScoreStat label="Deterministic rule checks" value={review.trustScore.components.ruleFlags} />
          </div>
        </div>
      )}

      {review.trustScore.evidence.length > 0 && (
        <div className="card">
          <h3 className="card-title">🎯 Evidence ({review.trustScore.evidence.length})</h3>
          {review.trustScore.evidence.map((f) => (
            <div className="finding" key={f.id}>
              <SeverityTag severity={f.severity} />
              <div className="finding-title">{f.title}</div>
              <div className="finding-loc">
                {f.file}
                {f.line ? `:${f.line}` : ""} · {f.source}
              </div>
              <p style={{ margin: "4px 0 0" }}>{f.detail}</p>
              {f.evidence && <pre className="finding-evidence">{f.evidence}</pre>}
            </div>
          ))}
        </div>
      )}

      {review.execution?.skippedReason && (
        <div className="card">
          <h3 className="card-title">🔒 Code not executed</h3>
          <p className="muted">
            {review.execution.skippedReason} Test and mutation scores below are neutral placeholders, not evidence.
          </p>
        </div>
      )}

      {review.testRun && (
        <div className="card">
          <h3 className="card-title">🧪 Generated tests</h3>
          <p>
            {review.testRun.passed}/{review.testRun.total} passed ({review.generatedTests.length} generated test file
            {review.generatedTests.length === 1 ? "" : "s"})
          </p>
          {review.testRun.failures.length > 0 && (
            <ul>
              {review.testRun.failures.map((f, i) => (
                <li key={i} className="mono">
                  {f.testName}: {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {review.mutation && (
        <div className="card">
          <h3 className="card-title">🧬 Mutation testing</h3>
          <p>
            <strong>{review.mutation.mutationScore}% mutation score</strong> — {review.mutation.killed} killed,{" "}
            {review.mutation.survived} survived, {review.mutation.noCoverage} uncovered, out of{" "}
            {review.mutation.totalMutants} mutants.
          </p>
          <p className="muted">
            A high survived-mutant count means the generated tests pass regardless of behavior changes — i.e. they
            don't meaningfully constrain this code, even if they're green.
          </p>
        </div>
      )}
    </div>
  );
}

function ScoreStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
