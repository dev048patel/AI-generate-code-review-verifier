import { useState, type PointerEvent } from "react";
import type { CommitPoint } from "../../atlasTypes";

const W = 320;
const H = 96;
const M = { top: 10, right: 40, bottom: 16, left: 34 };

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / pow) * pow;
}

function fmt(n: number): string {
  return Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(0)}K` : n.toLocaleString();
}

/**
 * One metric across commits. Single series, so no legend (the title names it);
 * value labelled at the end only; crosshair + tooltip on hover.
 */
export function MetricTrend({
  title,
  commits,
  value,
  onPick,
}: {
  title: string;
  commits: CommitPoint[];
  value: (c: CommitPoint) => number;
  onPick?: (c: CommitPoint) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = commits.map(value);
  const max = niceMax(Math.max(...values, 1));
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const x = (i: number) => M.left + (commits.length === 1 ? pw / 2 : (i / (commits.length - 1)) * pw);
  const y = (v: number) => M.top + ph - (v / max) * ph;
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values.length - 1;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * pw;
    setHover(Math.max(0, Math.min(last, Math.round((px / pw) * last))));
  };

  return (
    <figure className="atlas-trend">
      <figcaption className="stat-label">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title}: ${values[0]} to ${values[last]} over ${commits.length} commits`}>
        {[0, max].map((g) => (
          <g key={g}>
            <line x1={M.left} x2={M.left + pw} y1={y(g)} y2={y(g)} stroke="var(--border)" strokeWidth={1} />
            <text x={M.left - 6} y={y(g)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {fmt(g)}
            </text>
          </g>
        ))}
        <path d={d} fill="none" stroke="var(--viz-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last)} cy={y(values[last]!)} r={4} fill="var(--viz-1)" stroke="var(--panel)" strokeWidth={2} />
        <text x={x(last) + 7} y={y(values[last]!)} dy="0.32em" fontSize={11} fill="var(--text-primary)">
          {fmt(values[last]!)}
        </text>
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ph} stroke="var(--text-muted)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(values[hover]!)} r={4} fill="var(--viz-1)" stroke="var(--panel)" strokeWidth={2} />
          </g>
        )}
        <rect
          x={M.left}
          y={0}
          width={pw}
          height={H}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onClick={() => hover !== null && onPick?.(commits[hover]!)}
          style={{ cursor: onPick ? "pointer" : "crosshair" }}
        />
      </svg>
      {hover !== null && (
        <div className="atlas-chart-readout">
          <strong>{fmt(values[hover]!)}</strong> <span className="mono">{commits[hover]!.sha.slice(0, 7)}</span>{" "}
          <span className="muted">{commits[hover]!.subject.slice(0, 60)}</span>
        </div>
      )}
    </figure>
  );
}

/**
 * Lines added (up) and deleted (down) per commit on one shared scale; the
 * part of each deletion that removed code written within the last few
 * commits ("thrown away") is highlighted inside the deleted bar.
 */
export function ChurnChart({ commits, onPick }: { commits: CommitPoint[]; onPick?: (c: CommitPoint) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 200;
  const m = { top: 20, right: 12, bottom: 20, left: 44 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const shown = commits.slice(1); // the first commit's churn is its whole prior history
  // One giant commit (a migration, a vendored file) would flatten every other bar: cap the
  // axis near typical commit size and draw anything beyond it as a broken bar with its value.
  const maxUp = cappedMax(shown.map((c) => c.churn.added));
  const maxDown = cappedMax(shown.map((c) => c.churn.deleted));
  const mid = m.top + (ph * maxUp) / (maxUp + maxDown);
  const scale = ph / (maxUp + maxDown);
  const band = pw / Math.max(1, shown.length);
  const bw = Math.max(1, Math.min(24, band - 2)); // capped width, 2px surface gap between bars

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Lines added and deleted per commit">
        <line x1={m.left} x2={m.left + pw} y1={mid} y2={mid} stroke="var(--border-bright)" strokeWidth={1} />
        {[
          [maxUp, mid - maxUp * scale],
          [-maxDown, mid + maxDown * scale],
        ].map(([v, yy]) => (
          <g key={v}>
            <line x1={m.left} x2={m.left + pw} y1={yy} y2={yy} stroke="var(--border)" strokeWidth={1} />
            <text x={m.left - 6} y={yy} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {v! > 0 ? `+${fmt(v!)}` : `−${fmt(-v!)}`}
            </text>
          </g>
        ))}
        {shown.map((c, i) => {
          const x = m.left + i * band + (band - bw) / 2;
          const up = Math.min(c.churn.added, maxUp) * scale;
          const down = Math.min(c.churn.deleted, maxDown) * scale;
          const waste = Math.min(c.shortLivedLines, c.churn.deleted, maxDown) * scale;
          const upClipped = c.churn.added > maxUp;
          const downClipped = c.churn.deleted > maxDown;
          return (
            <g
              key={c.sha}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onClick={() => onPick?.(c)}
              style={{ cursor: onPick ? "pointer" : "default" }}
              opacity={hover !== null && hover !== i ? 0.55 : 1}
            >
              <rect x={m.left + i * band} y={m.top} width={band} height={ph} fill="transparent" />
              {up > 0 && <path d={roundedUp(x, mid, bw, up)} fill="var(--viz-1)" />}
              {down > 0 && <path d={roundedDown(x, mid, bw, down)} fill="var(--viz-3)" />}
              {waste > 0 && <rect x={x} y={mid} width={bw} height={Math.max(1, waste)} fill="var(--viz-2)" />}
              {upClipped && (
                <>
                  <rect x={x - 1} y={mid - up + 10} width={bw + 2} height={3} fill="var(--panel)" />
                  <text x={x + bw / 2} y={mid - up - 4} fontSize={10} textAnchor="middle" fill="var(--text-primary)">
                    +{fmt(c.churn.added)}
                  </text>
                </>
              )}
              {downClipped && (
                <>
                  <rect x={x - 1} y={mid + down - 13} width={bw + 2} height={3} fill="var(--panel)" />
                  <text x={x + bw / 2} y={mid + down + 12} fontSize={10} textAnchor="middle" fill="var(--text-primary)">
                    −{fmt(c.churn.deleted)}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: "var(--viz-1)" }} /> Lines added
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: "var(--viz-3)" }} /> Lines deleted
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: "var(--viz-2)" }} /> Deleted within a few commits of being written
        </span>
      </div>
      <div className="atlas-chart-readout" aria-live="polite">
        {hover !== null ? (
          <>
            <span className="mono">{shown[hover]!.sha.slice(0, 7)}</span> <span className="muted">{shown[hover]!.subject.slice(0, 70)}</span> ·{" "}
            <strong>+{shown[hover]!.churn.added}</strong> / <strong>−{shown[hover]!.churn.deleted}</strong>
            {shown[hover]!.shortLivedLines > 0 && <> · {shown[hover]!.shortLivedLines} thrown away</>}
          </>
        ) : (
          <span className="muted">Hover a commit for details{onPick ? "; click to compare it with its parent" : ""}.</span>
        )}
      </div>
    </div>
  );
}

/** Axis max that ignores extreme outliers (> 3x the 90th percentile); those bars are drawn broken. */
export function cappedMax(values: number[]): number {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return 5;
  const max = nonZero[nonZero.length - 1]!;
  const p90 = nonZero[Math.max(0, Math.floor(nonZero.length * 0.9) - 1)]!; // never the max itself for small samples
  return niceMax(nonZero.length >= 5 && max > p90 * 3 ? p90 * 1.5 : max);
}

// Bars: 4px rounded data end, square at the baseline.
function roundedUp(x: number, base: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + w - r} Q${x + w},${base - h} ${x + w},${base - h + r} V${base} Z`;
}

function roundedDown(x: number, base: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${base} V${base + h - r} Q${x},${base + h} ${x + r},${base + h} H${x + w - r} Q${x + w},${base + h} ${x + w},${base + h - r} V${base} Z`;
}
