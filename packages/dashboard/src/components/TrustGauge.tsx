import type { TrustScoreBreakdown } from "../types";

const COLOR: Record<TrustScoreBreakdown["label"], string> = {
  trusted: "var(--good)",
  "needs-review": "var(--warning)",
  "high-risk": "var(--critical)",
};

const LABEL_TEXT: Record<TrustScoreBreakdown["label"], string> = {
  trusted: "TRUSTED",
  "needs-review": "NEEDS REVIEW",
  "high-risk": "HIGH RISK",
};

const SIZE = 108;
const STROKE = 9;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A game-HUD-style circular "shield meter" for the trust score. */
export function TrustGauge({ trustScore }: { trustScore: TrustScoreBreakdown }) {
  const color = COLOR[trustScore.label];
  const pct = Math.max(0, Math.min(100, trustScore.score));
  const offset = CIRCUMFERENCE * (1 - pct / 100);

  return (
    <div className="gauge-wrap">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Trust score ${pct} out of 100, ${LABEL_TEXT[trustScore.label]}`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: "stroke-dashoffset 0.6s ease" }}
        />
        <text x="50%" y="47%" textAnchor="middle" dominantBaseline="middle" fontFamily="var(--font-display)" fontSize="22" fill={color}>
          {pct}
        </text>
        <text x="50%" y="66%" textAnchor="middle" dominantBaseline="middle" fontFamily="var(--font-mono)" fontSize="9" fill="var(--text-muted)">
          / 100
        </text>
      </svg>
      <div className="gauge-readout">
        <span className="gauge-score" style={{ color }}>
          {LABEL_TEXT[trustScore.label]}
        </span>
        <span className="gauge-label">trust score</span>
      </div>
    </div>
  );
}
