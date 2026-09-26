import { useState, type PointerEvent } from "react";
import type { CommitPoint } from "../../atlasTypes";
import { formatTokens, formatUsd, type Group, type SpendSummary } from "../../report/usage";

/**
 * Spend charts. Two measures with different units (tokens per commit,
 * dollars so far) get two aligned charts, never one chart with two y-axes.
 * Colours are the validated categorical pair for the dark surface
 * (blue = marked as AI-written, orange = everything else counted).
 */

export const AI_COLOR = "#3987e5";
export const OTHER_COLOR = "#d95926";
const GRID = "#1c2733";
const INK_2 = "#8fa9b6";
const W = 1000;
const M = { top: 12, right: 16, bottom: 22, left: 56 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

function useHover(n: number) {
  const [i, setI] = useState<number | null>(null);
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * (W - M.left - M.right);
    setI(Math.max(0, Math.min(n - 1, Math.floor((x / (W - M.left - M.right)) * n))));
  };
  return { i, onMove, clear: () => setI(null) };
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="chart-legend">
      {items.map((it) => (
        <span key={it.label} className="chart-legend-item">
          <span className="chart-swatch" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, lines }: { x: number; y: number; lines: string[] }) {
  const w = Math.max(...lines.map((l) => l.length)) * 7 + 16;
  const left = Math.min(Math.max(x - w / 2, 0), W - w);
  return (
    <g pointerEvents="none">
      <rect x={left} y={y} width={w} height={lines.length * 16 + 8} rx={4} fill="#0b0f14" stroke="#2c3f4f" />
      {lines.map((l, k) => (
        <text key={k} x={left + 8} y={y + 18 + k * 16} fontSize={12} fill={k === 0 ? "#e8fbff" : INK_2}>
          {l}
        </text>
      ))}
    </g>
  );
}

/** Tokens written per commit, stacked: marked as AI-written vs other counted code. */
export function TokensPerCommit({ summary, commits, onPick }: { summary: SpendSummary; commits: CommitPoint[]; onPick?: (sha: string) => void }) {
  const H = 220;
  const s = summary.series;
  const n = Math.max(1, s.length);
  const max = niceMax(Math.max(...s.map((p) => p.aiWritten + p.otherWritten), 0));
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const bw = pw / n;
  const gap = bw > 6 ? 2 : 0; // 2px surface gap between adjacent bars when there's room
  const y = (v: number) => M.top + ph - (v / max) * ph;
  const { i, onMove, clear } = useHover(n);
  const byId = new Map(commits.map((c) => [c.sha, c]));
  const hovered = i !== null ? s[i] : undefined;
  const hc = hovered ? byId.get(hovered.sha) : undefined;
  return (
    <figure className="chart">
      <figcaption className="chart-title">Tokens of code written per commit (estimated)</figcaption>
      <Legend items={[{ label: "Marked as AI-written", color: AI_COLOR }, ...(s.some((p) => p.otherWritten) ? [{ label: "Other code counted", color: OTHER_COLOR }] : [])]} />
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Estimated tokens written per commit">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(max * t)} y2={y(max * t)} stroke={GRID} />
            <text x={M.left - 8} y={y(max * t) + 4} fontSize={11} fill={INK_2} textAnchor="end">
              {formatTokens(max * t)}
            </text>
          </g>
        ))}
        {s.map((p, k) => {
          const x = M.left + k * bw + gap / 2;
          const w = Math.max(1, bw - gap);
          const aiTop = y(p.aiWritten);
          const otherTop = y(p.aiWritten + p.otherWritten);
          return (
            <g key={p.sha} opacity={i === null || i === k ? 1 : 0.55}>
              {p.aiWritten > 0 && <rect x={x} y={aiTop} width={w} height={y(0) - aiTop} fill={AI_COLOR} rx={Math.min(2, w / 2)} />}
              {p.otherWritten > 0 && <rect x={x} y={otherTop} width={w} height={Math.max(0, aiTop - otherTop - (p.aiWritten ? 1 : 0))} fill={OTHER_COLOR} rx={Math.min(2, w / 2)} />}
            </g>
          );
        })}
        <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} stroke="#2c3f4f" />
        <rect
          x={M.left}
          y={M.top}
          width={pw}
          height={ph}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={clear}
          onClick={() => hovered && onPick?.(hovered.sha)}
          style={{ cursor: onPick ? "pointer" : undefined }}
        />
        {hovered && hc && (
          <Tooltip
            x={M.left + (i! + 0.5) * bw}
            y={M.top}
            lines={[
              `${hc.sha.slice(0, 7)} ${hc.subject.slice(0, 44)}`,
              `${formatTokens(hovered.aiWritten + hovered.otherWritten)} tokens written${hc.ai ? ` · ${hc.ai.tool}` : ""}`,
              `+${hc.churn.added} / −${hc.churn.deleted} lines · ${hc.author}`,
            ]}
          />
        )}
      </svg>
    </figure>
  );
}

/** Running estimated cost across the same commits. */
export function CumulativeCost({ summary, commits }: { summary: SpendSummary; commits: CommitPoint[] }) {
  const H = 170;
  const s = summary.series;
  const n = Math.max(1, s.length);
  const max = niceMax(s[s.length - 1]?.cumulativeUsd ?? 0);
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const x = (k: number) => M.left + ((k + 0.5) / n) * pw;
  const y = (v: number) => M.top + ph - (v / max) * ph;
  const d = s.map((p, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(p.cumulativeUsd).toFixed(1)}`).join(" ");
  const { i, onMove, clear } = useHover(n);
  const byId = new Map(commits.map((c) => [c.sha, c]));
  const last = s[s.length - 1];
  return (
    <figure className="chart">
      <figcaption className="chart-title">Estimated cost so far</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Estimated cumulative cost across commits">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(max * t)} y2={y(max * t)} stroke={GRID} />
            <text x={M.left - 8} y={y(max * t) + 4} fontSize={11} fill={INK_2} textAnchor="end">
              {formatUsd(max * t)}
            </text>
          </g>
        ))}
        {s.length > 0 && <path d={d} fill="none" stroke={AI_COLOR} strokeWidth={2} strokeLinejoin="round" />}
        {last && (
          <text x={Math.min(x(s.length - 1), W - M.right) - 4} y={y(last.cumulativeUsd) - 8} fontSize={12} fill="#e8fbff" textAnchor="end">
            {formatUsd(last.cumulativeUsd)}
          </text>
        )}
        <rect x={M.left} y={M.top} width={pw} height={ph} fill="transparent" onPointerMove={onMove} onPointerLeave={clear} />
        {i !== null && s[i] && (
          <g pointerEvents="none">
            <line x1={x(i)} x2={x(i)} y1={M.top} y2={M.top + ph} stroke="#2c3f4f" />
            <circle cx={x(i)} cy={y(s[i]!.cumulativeUsd)} r={5} fill={AI_COLOR} stroke="#0b0f14" strokeWidth={2} />
            <Tooltip x={x(i)} y={M.top} lines={[`${formatUsd(s[i]!.cumulativeUsd)} after ${s[i]!.sha.slice(0, 7)}`, byId.get(s[i]!.sha)?.date.slice(0, 10) ?? ""]} />
          </g>
        )}
      </svg>
    </figure>
  );
}

/** Ranked horizontal bars: one measure, one colour, value labelled at the end. */
export function RankedBars({ title, groups, value, format, empty }: { title: string; groups: Group[]; value: (g: Group) => number; format: (n: number) => string; empty: string }) {
  const shown = groups.slice(0, 8);
  const max = Math.max(...shown.map(value), 0) || 1;
  return (
    <figure className="chart ranked">
      <figcaption className="chart-title">{title}</figcaption>
      {shown.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="ranked-list">
          {shown.map((g) => (
            <li key={g.key} title={`${g.commits} commits · +${g.linesAdded} lines · ${g.aiCommits} marked AI`}>
              <span className="ranked-label">{g.key}</span>
              <span className="ranked-track">
                <span className="ranked-bar" style={{ width: `${(value(g) / max) * 100}%` }} />
              </span>
              <span className="ranked-value">{format(value(g))}</span>
            </li>
          ))}
        </ul>
      )}
      {groups.length > 8 && <p className="muted small">+{groups.length - 8} more</p>}
    </figure>
  );
}
