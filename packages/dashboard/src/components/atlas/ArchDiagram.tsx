import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchComponent, ArchEdge, ArchHop, ArchStatus, ArchStory, ArchType } from "../../atlasTypes";
import { labelWidth, layoutArchitecture, TYPE_STYLE, ZONE_ORDER } from "./archLayout";

/**
 * The app as an architecture diagram: its real parts in zones, arrows for
 * what calls what, and guided stories that play one request through them.
 * Two modes, like a whiteboard and a sequence chart: "Architecture" shows
 * where the request goes, "Sequence" shows the order it happens in.
 */

type Mode = "architecture" | "sequence";

export interface DiagramData {
  components: Array<ArchComponent & { status?: ArchStatus }>;
  edges: Array<ArchEdge & { status?: ArchStatus }>;
  stories: ArchStory[];
}

const CANVAS = "#020617";
const PANEL = "#0B1220";
const INK = "#E2E8F0";
const MUTED = "#94A3B8";
const DIM = "#334155";
const KIND_COLOR: Record<ArchHop["kind"] | ArchEdge["kind"], string> = {
  request: "#22D3EE",
  call: "#34D399",
  data: "#A78BFA",
  return: "#94A3B8",
  gap: "#F43F5E",
};
const ADDED = "#4ADE80";
const REMOVED = "#F43F5E";
const HOP_MS = 1300;

function readHash(): { story?: string; mode?: Mode; step?: number } {
  if (typeof window === "undefined") return {};
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const step = Number(p.get("step"));
  const mode = p.get("mode");
  return {
    story: p.get("story") ?? undefined,
    mode: mode === "sequence" || mode === "architecture" ? mode : undefined,
    step: Number.isInteger(step) && step > 0 ? step : undefined,
  };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function edgeColor(e: ArchEdge & { status?: ArchStatus }, gapIds: Set<string>): string {
  if (e.status === "added") return ADDED;
  if (e.status === "removed") return REMOVED;
  if (gapIds.has(e.to) || gapIds.has(e.from)) return KIND_COLOR.gap;
  return KIND_COLOR[e.kind];
}

function Markers() {
  const colors = [...new Set([...Object.values(KIND_COLOR), ADDED, REMOVED, DIM])];
  return (
    <defs>
      {colors.map((c) => (
        <marker key={c} id={`arrow-${c.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={c} />
        </marker>
      ))}
      <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="4" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
        <path d="M24 0 L0 0 0 24" fill="none" stroke="#0F1A2E" strokeWidth="1" />
      </pattern>
    </defs>
  );
}

function NodeBox({
  c,
  x,
  y,
  w,
  h,
  dim,
  active,
  selected,
  onClick,
}: {
  c: ArchComponent & { status?: ArchStatus };
  x: number;
  y: number;
  w: number;
  h: number;
  dim: boolean;
  active: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const style = TYPE_STYLE[c.type];
  const stroke = c.status === "added" ? ADDED : c.status === "removed" ? REMOVED : style.color;
  const dashed = c.type === "gap" || c.status === "removed";
  const tag = c.status === "added" ? "new" : c.status === "removed" ? "removed" : c.tag;
  const tagColor = c.status === "added" ? ADDED : c.status === "removed" || c.type === "gap" || tag === "unchecked input" ? REMOVED : style.color;
  return (
    <g
      className="arch-node"
      data-testid="arch-node"
      data-id={c.id}
      role="button"
      tabIndex={0}
      aria-label={`${style.label}: ${c.label}${c.sublabel ? ` (${c.sublabel})` : ""}${tag ? `, ${tag}` : ""}`}
      opacity={dim ? 0.16 : 1}
      style={{ cursor: "pointer", transition: "opacity 0.3s" }}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      filter={active ? "url(#glow)" : undefined}
    >
      <rect x={x} y={y} width={w} height={h} rx={8} fill={active ? `${style.color}22` : PANEL} stroke={stroke} strokeWidth={selected || active ? 2.4 : 1.4} strokeDasharray={dashed ? "6 4" : undefined} />
      <text x={x + 12} y={y + 25} fontSize={13} fill={style.color}>
        {style.icon}
      </text>
      <text x={x + 34} y={y + 25} fontSize={13} fontWeight={700} fill={c.type === "gap" ? REMOVED : INK}>
        {clip(c.label, 21)}
      </text>
      {c.sublabel && (
        <text x={x + 12} y={y + 46} fontSize={10.5} fill={MUTED}>
          {clip(c.sublabel, 31)}
        </text>
      )}
      {tag && (
        <g>
          <rect x={x + w - labelWidth(tag) - 6} y={y - 9} width={labelWidth(tag)} height={17} rx={8.5} fill={CANVAS} stroke={tagColor} />
          <text x={x + w - labelWidth(tag) / 2 - 6} y={y + 3} fontSize={10} fill={tagColor} textAnchor="middle">
            {tag}
          </text>
        </g>
      )}
      <title>{[c.label, c.sublabel, ...c.sources.slice(0, 3).map((s) => `${s.file}${s.line ? `:${s.line}` : ""}`)].filter(Boolean).join("\n")}</title>
    </g>
  );
}

export function ArchDiagram({
  data,
  title,
  subtitle,
  summary,
  onOpenSteps,
  shareable = false,
}: {
  data: DiagramData;
  /** Keep the story / mode / step in the URL hash so a link opens the same view. */
  shareable?: boolean;
  title: string;
  subtitle?: string;
  /** Diff mode: one line per thing the change added or removed. */
  summary?: string[];
  onOpenSteps?: (routeId: string) => void;
}) {
  // Shareable state in the URL hash, like #story=post-api-users-login&mode=sequence&step=4
  const initial = useMemo(() => readHash(), []);
  const [mode, setMode] = useState<Mode>(initial.mode ?? "architecture");
  const [storyId, setStoryId] = useState<string | null>(initial.story && data.stories.some((s) => s.id === initial.story) ? initial.story : null);
  const [at, setAt] = useState(initial.step !== undefined ? initial.step - 1 : -1);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [lens, setLens] = useState<ArchType | null>(null);
  const [fit, setFit] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);

  const layout = useMemo(() => layoutArchitecture(data.components, data.edges), [data]);
  const byId = useMemo(() => new Map(data.components.map((c) => [c.id, c])), [data]);
  const gapIds = useMemo(() => new Set(data.components.filter((c) => c.type === "gap").map((c) => c.id)), [data]);
  const story = data.stories.find((s) => s.id === storyId) ?? null;
  const hops = story?.hops ?? [];
  const current = at >= 0 ? hops[at] : undefined;

  const firstStory = useRef(true);
  useEffect(() => {
    if (firstStory.current) {
      firstStory.current = false; // keep a step that came from the link
      return;
    }
    setAt(-1);
    setPlaying(false);
  }, [storyId]);

  useEffect(() => {
    if (!shareable) return;
    const params = new URLSearchParams();
    if (storyId) params.set("story", storyId);
    if (mode !== "architecture") params.set("mode", mode);
    if (storyId && at >= 0) params.set("step", String(at + 1));
    const hash = params.toString();
    if (`#${hash}` !== window.location.hash && (hash || window.location.hash)) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`);
    }
  }, [shareable, storyId, mode, at]);

  useEffect(() => {
    if (!playing) return;
    if (at >= hops.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setAt((i) => i + 1), at < 0 ? 0 : HOP_MS);
    return () => clearTimeout(t);
  }, [playing, at, hops.length]);

  // What's in focus: a story (up to the current hop while playing), a lens, or a clicked box and its neighbours.
  const focus = useMemo(() => {
    if (story) {
      const shown = at >= 0 ? hops.slice(0, at + 1) : hops;
      return {
        nodes: new Set(shown.flatMap((h) => [h.from, h.to])),
        edges: new Set(shown.map((h) => `${h.from}>${h.to}`)),
      };
    }
    if (lens) {
      const nodes = new Set(data.components.filter((c) => c.type === lens).map((c) => c.id));
      const edges = new Set(data.edges.filter((e) => nodes.has(e.from) || nodes.has(e.to)).map((e) => e.id));
      for (const e of data.edges) {
        if (!edges.has(e.id)) continue;
        nodes.add(e.from);
        nodes.add(e.to);
      }
      return { nodes, edges };
    }
    if (selected) {
      const edges = new Set(data.edges.filter((e) => e.from === selected || e.to === selected).map((e) => e.id));
      const nodes = new Set([selected, ...data.edges.filter((e) => edges.has(e.id)).flatMap((e) => [e.from, e.to])]);
      return { nodes, edges };
    }
    return null;
  }, [story, at, hops, lens, selected, data]);

  const pickStory = (id: string | null) => {
    setSelected(null);
    setLens(null);
    setStoryId(id);
  };

  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg || typeof URL.createObjectURL !== "function") return;
    const text = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w.-]+/g, "_")}-${mode}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const guided = data.stories.slice(0, 4);
  const typesPresent = [...new Set(data.components.map((c) => c.type))];
  const sel = selected ? byId.get(selected) : undefined;

  return (
    <div className="arch">
      <div className="arch-head">
        <div>
          <div className="arch-title">{title}</div>
          {subtitle && <div className="arch-subtitle">{subtitle}</div>}
        </div>
        <div className="arch-toolbar">
          <div className="arch-seg" role="group" aria-label="Diagram mode">
            {(["architecture", "sequence"] as Mode[]).map((m) => (
              <button key={m} className={mode === m ? "" : "secondary"} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "architecture" ? "Architecture" : "Sequence"}
              </button>
            ))}
          </div>
          <button className="secondary" aria-pressed={!fit} onClick={() => setFit((f) => !f)}>
            {fit ? "Zoom 100%" : "Fit to width"}
          </button>
          <button className="secondary" onClick={exportSvg}>
            Export SVG
          </button>
        </div>
      </div>

      {summary && summary.length > 0 && (
        <div className="arch-summary" aria-label="What this change did to the architecture">
          {summary.map((s) => (
            <span key={s} className={`arch-chip ${s.startsWith("⚠") || s.startsWith("−") ? "bad" : "good"}`}>
              {s}
            </span>
          ))}
        </div>
      )}

      {data.stories.length > 0 && (
        <div className="arch-guided">
          <div className="arch-guided-lead">
            <div className="stat-label">Guided views</div>
            <button
              onClick={() => {
                if (!story) pickStory(guided[0]!.id);
                if (at >= hops.length - 1) setAt(-1);
                setPlaying((p) => (story ? !p : true));
              }}
            >
              {playing ? "⏸ Pause" : "▶ Play story"}
            </button>
          </div>
          {guided.map((s, i) => (
            <button key={s.id} className={`arch-story${storyId === s.id ? " on" : ""}${s.severity === "high" || s.severity === "critical" ? " warn" : ""}`} onClick={() => pickStory(storyId === s.id ? null : s.id)}>
              <span className="arch-story-n">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className="arch-story-label">{s.label}</span>
                <span className="arch-story-title">{s.title}</span>
              </span>
            </button>
          ))}
          <select aria-label="Any request" value={storyId ?? ""} onChange={(e) => pickStory(e.target.value || null)}>
            <option value="">All requests ({data.stories.length})…</option>
            {data.stories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {story && (
        <div className="arch-caption" aria-live="polite">
          {current ? (
            <>
              <strong>
                {at + 1} / {hops.length}
              </strong>{" "}
              <span className="mono">{byId.get(current.from)?.label ?? current.from}</span> → <span className="mono">{byId.get(current.to)?.label ?? current.to}</span>:{" "}
              {current.note}
            </>
          ) : (
            <>
              <strong>{story.label}</strong>: {story.title}. {hops.length} hops. Press ▶ to play it, or step through.
            </>
          )}
          <span className="arch-caption-controls">
            <button className="secondary" aria-label="Previous hop" disabled={at <= 0} onClick={() => (setPlaying(false), setAt((i) => Math.max(0, i - 1)))}>
              ◀
            </button>
            <button className="secondary" aria-label="Next hop" disabled={at >= hops.length - 1} onClick={() => (setPlaying(false), setAt((i) => Math.min(hops.length - 1, i + 1)))}>
              ▶
            </button>
            {onOpenSteps && (
              <button className="secondary" onClick={() => onOpenSteps(story.routeId)}>
                Steps →
              </button>
            )}
          </span>
        </div>
      )}

      <div className="arch-canvas">
        {mode === "architecture" ? (
          <svg
            ref={svgRef}
            xmlns="http://www.w3.org/2000/svg"
            width={layout.width}
            height={layout.height}
            style={fit ? { width: "100%", height: "auto" } : undefined}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={`Architecture of ${title}`} fontFamily="JetBrains Mono, SF Mono, ui-monospace, monospace">
            <Markers />
            <rect width={layout.width} height={layout.height} fill={CANVAS} />
            <rect width={layout.width} height={layout.height} fill="url(#grid)" />
            {layout.zones.map((z) => (
              <g key={z.id}>
                <rect x={z.box.x} y={z.box.y} width={z.box.w} height={z.box.h} rx={12} fill="none" stroke="#1E293B" strokeDasharray="5 5" />
                <text x={z.box.x + 12} y={z.box.y + 18} fontSize={10} fill={MUTED} letterSpacing="0.12em">
                  {z.label.toUpperCase()}
                </text>
              </g>
            ))}
            {data.edges.map((e) => {
              const r = layout.edges.get(e.id);
              if (!r) return null;
              const inFocus = !focus || focus.edges.has(e.id);
              const isCurrent = current && `${current.from}>${current.to}` === e.id;
              const color = inFocus ? edgeColor(e, gapIds) : DIM;
              const storyLabel = story && inFocus ? story.hops.find((h) => `${h.from}>${h.to}` === e.id)?.label : undefined;
              const text = storyLabel ?? r.label?.text;
              const lx = r.label?.x ?? (r.points[1]![0] + r.points[2]![0]) / 2;
              const ly = r.label?.y ?? (r.points[1]![1] + r.points[2]![1]) / 2;
              return (
                <g key={e.id} data-testid="arch-edge" data-id={e.id} opacity={inFocus ? 1 : 0.35}>
                  {/* Halo instead of an SVG filter: filters vanish on perfectly straight lines (zero-height bounding box). */}
                  {isCurrent && <path d={r.d} fill="none" stroke={color} strokeWidth={9} strokeOpacity={0.25} strokeLinejoin="round" />}
                  <path
                    d={r.d}
                    fill="none"
                    stroke={color}
                    strokeWidth={isCurrent ? 3 : inFocus && focus ? 2 : 1.3}
                    strokeDasharray={e.status === "removed" || gapIds.has(e.to) ? "6 4" : undefined}
                    markerEnd={`url(#arrow-${color.slice(1)})`}
                  >
                    <title>{e.labels.join("\n")}</title>
                  </path>
                  {text && (inFocus || !focus) && (r.label || storyLabel) && (
                    <g>
                      <rect x={lx - labelWidth(clip(text, 30)) / 2} y={ly - 9} width={labelWidth(clip(text, 30))} height={18} rx={4} fill={CANVAS} stroke={color} strokeWidth={0.8} />
                      <text x={lx} y={ly + 4} fontSize={10.5} fill={color} textAnchor="middle">
                        {clip(text, 30)}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
            {data.components.map((c) => {
              const b = layout.nodes.get(c.id)!;
              const active = Boolean(current && (current.to === c.id || (current.kind === "return" && current.to === c.id)));
              return (
                <NodeBox
                  key={c.id}
                  c={c}
                  {...b}
                  dim={Boolean(focus && !focus.nodes.has(c.id))}
                  active={active}
                  selected={selected === c.id}
                  onClick={() => {
                    setStoryId(null);
                    setLens(null);
                    setSelected(selected === c.id ? null : c.id);
                  }}
                />
              );
            })}
            {current && <HopDot hop={current} layout={layout} key={`${storyId}-${at}`} />}
          </svg>
        ) : (
          <SequenceView story={story} byId={byId} at={at} fit={fit} svgRef={svgRef} onPick={() => pickStory(guided[0]?.id ?? null)} />
        )}
      </div>

      <div className="arch-legend">
        {typesPresent.map((t) => (
          <button key={t} className={`arch-legend-item${lens === t ? " on" : ""}`} aria-pressed={lens === t} onClick={() => (setStoryId(null), setSelected(null), setLens(lens === t ? null : t))}>
            <span className="arch-swatch" style={{ borderColor: TYPE_STYLE[t].color, borderStyle: t === "gap" ? "dashed" : "solid" }} />
            {TYPE_STYLE[t].label}
          </button>
        ))}
        {summary && (
          <>
            <span className="arch-legend-item static">
              <span className="arch-swatch" style={{ borderColor: ADDED }} /> added
            </span>
            <span className="arch-legend-item static">
              <span className="arch-swatch" style={{ borderColor: REMOVED, borderStyle: "dashed" }} /> removed
            </span>
          </>
        )}
      </div>

      {sel && (
        <div className="arch-detail" aria-label={`Details for ${sel.label}`}>
          <div className="arch-detail-head">
            <span style={{ color: TYPE_STYLE[sel.type].color }}>
              {TYPE_STYLE[sel.type].icon} {TYPE_STYLE[sel.type].label}
            </span>
            <strong>{sel.label}</strong>
            {sel.sublabel && <span className="muted">{sel.sublabel}</span>}
            <button className="secondary" onClick={() => setSelected(null)} aria-label="Close details">
              ✕
            </button>
          </div>
          <div className="grid-2">
            <div>
              <div className="stat-label">In the code</div>
              {sel.sources.length ? (
                <ul className="arch-list">
                  {sel.sources.map((s) => (
                    <li key={`${s.file}:${s.line}`} className="mono">
                      {s.file}
                      {s.line ? `:${s.line}` : ""} {s.label && <span className="muted">· {s.label}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{sel.type === "gap" ? "Nothing — that's the problem: this safeguard doesn't exist yet." : "Not tied to one place in the code."}</p>
              )}
              <div className="stat-label">Connections</div>
              <ul className="arch-list">
                {data.edges
                  .filter((e) => e.from === sel.id || e.to === sel.id)
                  .map((e) => (
                    <li key={e.id}>
                      {e.from === sel.id ? "→" : "←"} {byId.get(e.from === sel.id ? e.to : e.from)?.label}: <span className="muted">{e.labels.slice(0, 4).join(", ")}</span>
                    </li>
                  ))}
              </ul>
            </div>
            <div>
              <div className="stat-label">Requests through here ({sel.routes.length})</div>
              <ul className="arch-list">
                {sel.routes.slice(0, 20).map((rid) => {
                  const s = data.stories.find((x) => x.routeId === rid);
                  return (
                    <li key={rid}>
                      {s ? (
                        <button className="link-button" onClick={() => pickStory(s.id)}>
                          {s.label}
                        </button>
                      ) : (
                        rid.replace(/^r:/, "")
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A glowing dot that travels the current hop; returns fly straight back to the client. */
function HopDot({ hop, layout }: { hop: ArchHop; layout: ReturnType<typeof layoutArchitecture> }) {
  const route = layout.edges.get(`${hop.from}>${hop.to}`);
  const s = layout.nodes.get(hop.from);
  const t = layout.nodes.get(hop.to);
  if (!s || !t) return null;
  const d = route?.d ?? `M${s.x},${s.y + s.h / 2} L${t.x + t.w},${t.y + t.h / 2}`;
  const color = KIND_COLOR[hop.kind];
  return (
    <g>
      {!route && <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeDasharray="5 5" opacity={0.8} markerEnd={`url(#arrow-${color.slice(1)})`} />}
      {!route && (
        <g>
          <rect x={t.x + t.w + 8} y={t.y - 20} width={labelWidth(clip(hop.label, 30))} height={18} rx={4} fill={CANVAS} stroke={color} />
          <text x={t.x + t.w + 8 + labelWidth(clip(hop.label, 30)) / 2} y={t.y - 7} fontSize={10.5} fill={color} textAnchor="middle">
            {clip(hop.label, 30)}
          </text>
        </g>
      )}
      <circle r={6} fill={color} filter="url(#glow)" data-testid="hop-dot">
        <animateMotion dur="0.9s" fill="freeze" path={d} />
      </circle>
    </g>
  );
}

const SEQ_COL = 188;
const SEQ_ROW = 46;
const SEQ_TOP = 96;

function SequenceView({
  story,
  byId,
  at,
  fit,
  svgRef,
  onPick,
}: {
  story: ArchStory | null;
  byId: Map<string, ArchComponent>;
  at: number;
  fit: boolean;
  svgRef: React.RefObject<SVGSVGElement>;
  onPick: () => void;
}) {
  if (!story) {
    return (
      <div className="arch-empty">
        <p>The sequence view plays one request in order: who calls whom, and what comes back.</p>
        <button onClick={onPick}>Show the first guided view</button>
      </div>
    );
  }
  const order = (id: string) => ZONE_ORDER.indexOf(byId.get(id)?.zone ?? "services");
  const firstSeen = new Map<string, number>();
  story.hops.forEach((h, i) => [h.from, h.to].forEach((x) => !firstSeen.has(x) && firstSeen.set(x, i)));
  const parts = [...firstSeen.keys()].sort((a, b) => order(a) - order(b) || firstSeen.get(a)! - firstSeen.get(b)!);
  const cx = (id: string) => 24 + parts.indexOf(id) * SEQ_COL + SEQ_COL / 2;
  const width = 48 + parts.length * SEQ_COL;
  const height = SEQ_TOP + story.hops.length * SEQ_ROW + 30;
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      style={fit ? { width: "100%", height: "auto", maxWidth: width * 1.4 } : undefined}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Sequence of ${story.label}`} fontFamily="JetBrains Mono, SF Mono, ui-monospace, monospace">
      <Markers />
      <rect width={width} height={height} fill={CANVAS} />
      <rect width={width} height={height} fill="url(#grid)" />
      {parts.map((id) => {
        const c = byId.get(id);
        const style = TYPE_STYLE[c?.type ?? "service"];
        const x = cx(id);
        return (
          <g key={id} data-testid="seq-participant">
            <line x1={x} y1={70} x2={x} y2={height - 12} stroke="#1E293B" strokeDasharray="4 5" />
            <rect x={x - 80} y={16} width={160} height={52} rx={8} fill={PANEL} stroke={style.color} strokeDasharray={c?.type === "gap" ? "6 4" : undefined} />
            <text x={x} y={38} fontSize={12.5} fontWeight={700} fill={c?.type === "gap" ? REMOVED : INK} textAnchor="middle">
              {style.icon} {clip(c?.label ?? id, 17)}
            </text>
            {c?.sublabel && (
              <text x={x} y={56} fontSize={10} fill={MUTED} textAnchor="middle">
                {clip(c.sublabel, 26)}
              </text>
            )}
          </g>
        );
      })}
      {story.hops.map((h, i) => {
        const y = SEQ_TOP + i * SEQ_ROW + 20;
        const x1 = cx(h.from);
        const x2 = cx(h.to);
        const color = KIND_COLOR[h.kind];
        const state = at < 0 ? "shown" : i < at ? "done" : i === at ? "current" : "later";
        const dir = x2 > x1 ? 1 : -1;
        return (
          <g key={i} data-testid="seq-hop" data-state={state} opacity={state === "later" ? 0.14 : 1} style={{ transition: "opacity 0.3s" }}>
            {state === "current" && <line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth={9} strokeOpacity={0.25} />}
            <line
              x1={x1 + dir * 4}
              y1={y}
              x2={x2 - dir * 4}
              y2={y}
              stroke={color}
              strokeWidth={state === "current" ? 3 : 1.6}
              strokeDasharray={h.kind === "return" || h.kind === "gap" ? "6 4" : undefined}
              markerEnd={`url(#arrow-${color.slice(1)})`}
            />
            <text x={(x1 + x2) / 2} y={y - 7} fontSize={10.5} fill={color} textAnchor="middle">
              {h.kind === "gap" ? "⚠ " : ""}
              {clip(h.label, 34)}
            </text>
            <text x={Math.min(x1, x2) - 10} y={y + 4} fontSize={9.5} fill={DIM} textAnchor="end">
              {i + 1}
            </text>
            <title>{h.note}</title>
          </g>
        );
      })}
    </svg>
  );
}
