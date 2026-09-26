import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { AtlasFinding, GraphDiff, RepoGraph, RuntimeView } from "../../atlasTypes";

export type MapKind = "module" | "route" | "package" | "group" | "database" | "external" | "service" | "internal";
export type MapStatus = "added" | "removed" | "broken" | "unchanged";

export interface MapNode {
  id: string;
  kind: MapKind;
  label: string;
  group: string;
  detail?: string;
  status?: MapStatus;
  /** Worst finding severity on this node, if any. */
  severity?: AtlasFinding["severity"];
  findings?: string[];
  /** Relative size (lines of code, module count, call count). */
  weight?: number;
}

export interface MapEdge {
  from: string;
  to: string;
  status?: MapStatus;
  label?: string;
  weight?: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Past this many modules the map shows directories instead of files, so it stays readable. */
export const COLLAPSE_THRESHOLD = 220;
const MAX_PACKAGES = 20;

const SEVERITY_ORDER: Record<AtlasFinding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function worst(a: AtlasFinding["severity"] | undefined, b: AtlasFinding["severity"]): AtlasFinding["severity"] {
  return a === undefined || SEVERITY_ORDER[b] < SEVERITY_ORDER[a] ? b : a;
}

/** Turns a repo graph into map nodes/edges, collapsing files into directories for big repos. */
export function toMap(graph: RepoGraph, options: { collapse?: boolean } = {}): { nodes: MapNode[]; edges: MapEdge[] } {
  const modules = graph.nodes.filter((n) => n.kind === "module");
  const collapse = options.collapse ?? modules.length > COLLAPSE_THRESHOLD;
  const findingsByNode = new Map<string, AtlasFinding[]>();
  for (const f of graph.findings) {
    if (!f.nodeId) continue;
    findingsByNode.set(f.nodeId, [...(findingsByNode.get(f.nodeId) ?? []), f]);
  }

  // Keep the most-used packages; the long tail is noise on a map.
  const pkgDegree = new Map<string, number>();
  for (const e of graph.edges) if (e.to.startsWith("p:")) pkgDegree.set(e.to, (pkgDegree.get(e.to) ?? 0) + 1);
  const keptPkgs = new Set([...pkgDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PACKAGES).map(([id]) => id));

  const idOf = (id: string): string | undefined => {
    if (id.startsWith("p:")) return keptPkgs.has(id) ? id : undefined;
    if (!collapse || !id.startsWith("m:")) return id;
    const node = graph.nodes.find((n) => n.id === id);
    return node ? `g:${node.group}` : undefined;
  };

  const nodes = new Map<string, MapNode>();
  for (const n of graph.nodes) {
    const id = idOf(n.id);
    if (!id) continue;
    const fs = findingsByNode.get(n.id) ?? [];
    const existing = nodes.get(id);
    if (existing) {
      existing.weight = (existing.weight ?? 0) + (n.loc ?? 1);
      for (const f of fs) {
        existing.severity = worst(existing.severity, f.severity);
        existing.findings = [...(existing.findings ?? []), f.title];
      }
      continue;
    }
    const isGroup = id.startsWith("g:");
    nodes.set(id, {
      id,
      kind: isGroup ? "group" : n.kind,
      label: isGroup ? `${n.group}/` : n.label,
      group: n.group,
      detail: isGroup ? undefined : n.file,
      weight: n.loc ?? 1,
      severity: fs.reduce<AtlasFinding["severity"] | undefined>((acc, f) => worst(acc, f.severity), undefined),
      findings: fs.length ? fs.map((f) => f.title) : undefined,
    });
  }

  const edges = new Map<string, MapEdge>();
  for (const e of graph.edges) {
    const from = idOf(e.from);
    const to = idOf(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    const existing = edges.get(key);
    if (existing) existing.weight = (existing.weight ?? 1) + 1;
    else edges.set(key, { from, to, weight: 1, ...(e.broken ? { status: "broken" as const } : {}) });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Before/after maps on one shared layout: every node keeps its position in
 * both, so the eye sees exactly what appeared, vanished or broke.
 */
export function toDiffMaps(before: RepoGraph, after: RepoGraph, diff: GraphDiff) {
  const collapse = Math.max(before.metrics.modules, after.metrics.modules) > COLLAPSE_THRESHOLD;
  const b = toMap(before, { collapse });
  const a = toMap(after, { collapse });
  const beforeIds = new Set(b.nodes.map((n) => n.id));
  const afterIds = new Set(a.nodes.map((n) => n.id));
  const brokenNodes = new Set(diff.newFindings.map((f) => f.nodeId).filter(Boolean));
  const statusOf = (id: string): MapStatus =>
    !beforeIds.has(id) ? "added" : !afterIds.has(id) ? "removed" : brokenNodes.has(id) ? "broken" : "unchanged";

  const beforeNodes = b.nodes.map((n) => ({ ...n, status: afterIds.has(n.id) ? ("unchanged" as const) : ("removed" as const) }));
  const afterNodes = a.nodes.map((n) => ({ ...n, status: statusOf(n.id) }));
  const beforeEdgeKeys = new Set(b.edges.map((e) => `${e.from}>${e.to}`));
  const afterEdgeKeys = new Set(a.edges.map((e) => `${e.from}>${e.to}`));
  const beforeEdges = b.edges.map((e) => ({ ...e, status: afterEdgeKeys.has(`${e.from}>${e.to}`) ? e.status : ("removed" as const) }));
  const afterEdges = a.edges.map((e) => ({ ...e, status: e.status ?? (beforeEdgeKeys.has(`${e.from}>${e.to}`) ? undefined : ("added" as const)) }));

  const union = new Map<string, MapNode>();
  for (const n of [...beforeNodes, ...afterNodes]) union.set(n.id, n);
  const unionEdges = [...b.edges, ...a.edges];
  return {
    before: { nodes: beforeNodes, edges: beforeEdges },
    after: { nodes: afterNodes, edges: afterEdges },
    union: { nodes: [...union.values()], edges: unionEdges },
  };
}

/** The live call graph from runtime traces, in the same node vocabulary as the code map. */
export function runtimeMap(view: RuntimeView): { nodes: MapNode[]; edges: MapEdge[] } {
  const nodes: MapNode[] = view.snapshot.nodes.map((n) => ({
    id: n.id,
    kind: n.kind === "route" ? "route" : n.kind,
    label: n.label,
    group: n.kind,
    weight: n.calls,
    detail: `${n.calls} call(s)${n.errors ? `, ${n.errors} error(s)` : ""}`,
    ...(n.errors > 0 ? { severity: "high" as const, findings: [`${n.errors} of ${n.calls} calls failed`] } : {}),
  }));
  const edges: MapEdge[] = view.snapshot.edges.map((e) => ({
    from: e.from,
    to: e.to,
    weight: e.calls,
    label: `${e.p95Ms}ms p95`,
    ...(e.errors > 0 ? { status: "broken" as const } : {}),
  }));
  return { nodes, edges };
}

/** Small deterministic PRNG so the same graph always lays out the same way. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Entry points on the left, the app's own code in the middle, what it depends on on the right. */
export function columnOf(kind: MapKind): "left" | "middle" | "right" {
  if (kind === "route") return "left";
  if (kind === "package" || kind === "external" || kind === "database") return "right";
  return "middle";
}

export const COLUMN_X = { left: 0.26, right: 0.76 };
/** Middle band the app's own modules are fitted into. */
const MIDDLE = { from: 0.34, to: 0.66 };

/**
 * Layered layout that reads like a request: routes (left) -> modules
 * (middle, force-directed and clustered by directory) -> packages, APIs and
 * databases (right). Side columns are sorted and evenly spaced so their
 * labels never collide; the same graph always gets the same layout.
 */
export function layoutGraph(nodes: MapNode[], edges: MapEdge[], size: { width: number; height: number }): Map<string, Point> {
  type SimNode = SimulationNodeDatum & { id: string; group: string; col: "left" | "middle" | "right" };
  const pad = 28;
  const out = new Map<string, Point>();

  // Side columns: fixed, evenly spaced, alphabetical.
  const place = (col: "left" | "right") => {
    const list = nodes.filter((n) => columnOf(n.kind) === col).sort((a, b) => a.label.localeCompare(b.label));
    const step = (size.height - pad * 2) / Math.max(1, list.length);
    list.forEach((n, i) => out.set(n.id, { x: size.width * COLUMN_X[col], y: pad + step * (i + 0.5) }));
  };
  place("left");
  place("right");

  const middle = nodes.filter((n) => columnOf(n.kind) === "middle");
  if (middle.length === 0) return out;
  const groups = [...new Set(middle.map((n) => n.group))].sort();
  const anchorY = new Map(groups.map((g, i) => [g, ((i + 0.5) / groups.length) * size.height]));
  const sim: SimNode[] = [
    ...middle.map((n) => ({ id: n.id, group: n.group, col: "middle" as const })),
    // Side nodes take part (fixed) so modules settle near what they connect to.
    ...[...out.entries()].map(([id, p]) => ({ id, group: "", col: "left" as const, fx: p.x, fy: p.y })),
  ];
  const ids = new Set(sim.map((n) => n.id));
  const links = edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ source: e.from, target: e.to }));
  const simulation = forceSimulation(sim)
    .randomSource(lcg(42))
    .force("link", forceLink<SimNode, { source: string; target: string }>(links).id((d) => d.id).distance(40).strength(0.25))
    .force("charge", forceManyBody<SimNode>().strength(middle.length > 150 ? -35 : -80))
    .force("collide", forceCollide(14))
    .force("x", forceX<SimNode>(size.width / 2).strength(0.05))
    .force("y", forceY<SimNode>((d) => anchorY.get(d.group) ?? size.height / 2).strength(0.12))
    .stop();
  const ticks = Math.min(300, 80 + middle.length * 2);
  for (let i = 0; i < ticks; i++) simulation.tick();

  // Fit the free (middle) nodes into their band, preserving aspect ratio.
  const free = sim.filter((n) => n.col === "middle");
  const xs = free.map((n) => n.x ?? 0);
  const ys = free.map((n) => n.y ?? 0);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const bandW = size.width * (MIDDLE.to - MIDDLE.from);
  const bandH = size.height - pad * 2;
  const scale = Math.min(bandW / Math.max(1, maxX - minX), bandH / Math.max(1, maxY - minY), 1.4);
  const offX = size.width * MIDDLE.from + (bandW - (maxX - minX) * scale) / 2;
  const offY = pad + (bandH - (maxY - minY) * scale) / 2;
  for (const n of free) out.set(n.id, { x: offX + ((n.x ?? 0) - minX) * scale, y: offY + ((n.y ?? 0) - minY) * scale });
  return out;
}
