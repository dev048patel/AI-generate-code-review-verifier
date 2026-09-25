import type { TrustScoreBreakdown } from "../types";

const LABEL_TEXT: Record<TrustScoreBreakdown["label"], string> = {
  trusted: "Trusted",
  "needs-review": "Needs review",
  "high-risk": "High risk",
};

export function TrustScoreBadge({ trustScore }: { trustScore: TrustScoreBreakdown }) {
  return (
    <span className={`badge ${trustScore.label}`}>
      <span className="dot" aria-hidden="true" />
      {trustScore.score} · {LABEL_TEXT[trustScore.label]}
    </span>
  );
}

export function SeverityTag({ severity }: { severity: string }) {
  return <span className={`severity ${severity}`}>{severity}</span>;
}
