import { useState } from "react";
import { columnOf, type MapEdge, type MapKind, type MapNode, type Point } from "./layout";

/** Validated with the dataviz palette checker on the #0b0f14 panel (all pairs pass; shapes are the required secondary cue). */
export const KIND_STYLE: Record<MapKind, { color: string; shape: "circle" | "diamond" | "square"; label: string }> = {
  module: { color: "var(--viz-1)", shape: "circle", label: "Module" },
  group: { color: "var(--viz-1)", shape: "circle", label: "Directory" },
  service: { color: "var(--viz-1)", shape: "circle", label: "Service" },
  internal: { color: "var(--viz-1)", shape: "circle", label: "Internal step" },
  route: { color: "var(--viz-2)", shape: "diamond", label: "HTTP route" },
  package: { color: "var(--viz-3)", shape: "square", label: "Package" },
  external: { color: "var(--viz-3)", shape: "square", label: "External API" },
  database: { color: "var(--viz-3)", shape: "square", label: "Database" },
};

function radius(n: MapNode): number {
  const base = n.kind === "group" ? 7 : n.kind === "route" ? 6 : 5;
  return Math.min(16, base + Math.sqrt(n.weight ?? 1) / (n.kind === "group" ? 8 : 12));
}

function Shape({ node, p, r }: { node: MapNode; p: Point; r: number }) {
  const style = KIND_STYLE[node.kind];
  const common = {
    fill: style.color,
    stroke: "var(--panel)",
    strokeWidth: 2, // surface ring keeps overlapping marks legible
    opacity: node.status === "removed" ? 0.35 : 1,
  };
  if (style.shape === "diamond") {
    const d = r * 1.3;
    return <polygon points={`${p.x},${p.y - d} ${p.x + d},${p.y} ${p.x},${p.y + d} ${p.x - d},${p.y}`} {...common} />;
  }
  if (style.shape === "square") return <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={2} {...common} />;
  return <circle cx={p.x} cy={p.y} r={r} {...common} />;
}

/** A status ring outside the mark: status is never color-only (dash + icon + legend text carry it too). */
function StatusRing({ node, p, r }: { node: MapNode; p: Point; r: number }) {
  // Glyph on the side away from the label (right-column labels sit to the right).
  const gx = columnOf(node.kind) === "right" ? p.x - r - 12 : p.x + r + 5;
  const bad = node.status === "broken" || node.severity === "critical" || node.severity === "high";
  const warn = !bad && node.severity === "medium";
  const color =
    node.status === "added" ? "var(--good)" : node.status === "removed" || bad ? "var(--critical)" : warn ? "var(--warning)" : undefined;
  if (!color) return null;
  return (
    <g>
      <circle
        cx={p.x}
        cy={p.y}
        r={r + 5}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={node.status === "removed" ? "3 3" : undefined}
      />
      {(bad || node.status === "removed") && (
        <text x={gx} y={p.y - r - 3} fontSize={11} fill="var(--text-primary)" aria-hidden="true">
          {node.status === "removed" ? "−" : "✕"}
        </text>
      )}
      {node.status === "added" && (
        <text x={gx} y={p.y - r - 3} fontSize={11} fill="var(--text-primary)" aria-hidden="true">
          +
        </text>
      )}
    </g>
  );
}

export interface GraphMapProps {
  nodes: MapNode[];
  edges: MapEdge[];
  positions: Map<string, Point>;
  width: number;
  height: number;
  title: string;
  /** Label only the nodes that matter (routes, flagged, changed) — never every node. */
  labelAll?: boolean;
  highlight?: string;
  onSelect?: (node: MapNode) => void;
}

export function GraphMap({ nodes, edges, positions, width, height, title, labelAll, highlight, onSelect }: GraphMapProps) {
  const [hover, setHover] = useState<MapNode | null>(null);
  const hovered = hover ? positions.get(hover.id) : undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const maxWeight = Math.max(1, ...edges.map((e) => e.weight ?? 1));
  const changedMiddle = nodes.filter((n) => columnOf(n.kind) === "middle" && (n.status === "added" || n.status === "removed")).length;
  const sideSpacing = {
    left: height / Math.max(1, nodes.filter((n) => columnOf(n.kind) === "left").length),
    right: height / Math.max(1, nodes.filter((n) => columnOf(n.kind) === "right").length),
  };

  return (
    <div className="atlas-map" style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={title}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-bright)" />
          </marker>
        </defs>
        <g>
          {edges.map((e) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b || !byId.has(e.from) || !byId.has(e.to)) return null;
            const active = hover && (hover.id === e.from || hover.id === e.to);
            const stroke =
              e.status === "broken" || e.status === "removed"
                ? "var(--critical)"
                : e.status === "added"
                  ? "var(--good)"
                  : active
                    ? "var(--text-secondary)"
                    : "var(--border-bright)";
            return (
              <g key={`${e.from}>${e.to}`}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={stroke}
                  strokeWidth={e.status === "added" ? 1 : 1 + ((e.weight ?? 1) / maxWeight) * 2}
                  strokeDasharray={e.status === "removed" || e.status === "broken" ? "4 3" : undefined}
                  opacity={hover && !active ? 0.2 : e.status === "added" ? 0.45 : 0.8}
                  markerEnd="url(#arrow)"
                />
                {e.label && (active || edges.length <= 12) && (
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} fontSize={10} textAnchor="middle" fill="var(--text-secondary)">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        <g>
          {nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const r = radius(n);
            const col = columnOf(n.kind);
            const flagged = n.status === "added" || n.status === "removed" || n.severity === "high" || n.severity === "critical" || highlight === n.id;
            // Side columns are evenly spaced: label them while the spacing allows it, flagged ones always.
            const serious = n.severity === "high" || n.severity === "critical" || highlight === n.id;
            // Changed files get labels only while they're few; big rewrites rely on rings, tooltips and the change list.
            const showLabel =
              col === "middle"
                ? labelAll || n.kind === "group" || serious || (flagged && changedMiddle <= 10)
                : flagged || sideSpacing[col] >= 13;
            const labelProps =
              col === "left"
                ? { x: p.x - r - 8, y: p.y, dy: "0.32em", textAnchor: "end" as const }
                : col === "right"
                  ? { x: p.x + r + 8, y: p.y, dy: "0.32em", textAnchor: "start" as const }
                  : { x: p.x, y: p.y + r + 13, textAnchor: "middle" as const };
            return (
              <g
                key={n.id}
                tabIndex={0}
                role="button"
                aria-label={`${KIND_STYLE[n.kind].label} ${n.label}${n.status && n.status !== "unchanged" ? `, ${n.status}` : ""}${n.findings ? `, ${n.findings.length} finding(s)` : ""}`}
                onPointerEnter={() => setHover(n)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(n)}
                onBlur={() => setHover(null)}
                onClick={() => onSelect?.(n)}
                style={{ cursor: onSelect ? "pointer" : "default", outline: "none" }}
              >
                {/* Hit target bigger than the mark. */}
                <circle cx={p.x} cy={p.y} r={Math.max(12, r + 6)} fill="transparent" />
                {highlight === n.id && <circle cx={p.x} cy={p.y} r={r + 10} fill="none" stroke="var(--text-primary)" strokeWidth={1} />}
                <StatusRing node={n} p={p} r={r} />
                <Shape node={n} p={p} r={r} />
                {showLabel && (
                  <text {...labelProps} fontSize={10} fill={flagged ? "var(--text-primary)" : "var(--text-secondary)"}>
                    {n.label.length > 32 ? `${n.label.slice(0, 31)}…` : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {hover && hovered && (
        <div className="atlas-tooltip" style={{ left: `${(hovered.x / width) * 100}%`, top: `${(hovered.y / height) * 100}%` }}>
          <strong>{hover.label}</strong>
          <div className="muted">
            {KIND_STYLE[hover.kind].label}
            {hover.status && hover.status !== "unchanged" ? ` · ${hover.status}` : ""}
          </div>
          {hover.detail && <div className="mono">{hover.detail}</div>}
          {hover.findings?.slice(0, 4).map((f) => (
            <div key={f} className="atlas-tooltip-finding">
              ✕ {f}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MapLegend({ kinds, statuses }: { kinds: MapKind[]; statuses?: boolean }) {
  const shapes = [...new Map(kinds.map((k) => [KIND_STYLE[k].label, k])).values()];
  return (
    <div className="legend">
      {shapes.map((k) => (
        <span key={k} className="legend-item">
          <svg width="14" height="14" aria-hidden="true">
            <Shape node={{ id: k, kind: k, label: "", group: "" }} p={{ x: 7, y: 7 }} r={5} />
          </svg>
          {KIND_STYLE[k].label}
        </span>
      ))}
      <span className="legend-item">
        <svg width="18" height="14" aria-hidden="true">
          <circle cx={7} cy={7} r={6} fill="none" stroke="var(--critical)" strokeWidth={2} />
        </svg>
        ✕ Problem / broken
      </span>
      {statuses && (
        <>
          <span className="legend-item">
            <svg width="18" height="14" aria-hidden="true">
              <circle cx={7} cy={7} r={6} fill="none" stroke="var(--good)" strokeWidth={2} />
            </svg>
            + Added
          </span>
          <span className="legend-item">
            <svg width="18" height="14" aria-hidden="true">
              <circle cx={7} cy={7} r={6} fill="none" stroke="var(--critical)" strokeWidth={2} strokeDasharray="3 3" />
            </svg>
            − Removed
          </span>
        </>
      )}
    </div>
  );
}
