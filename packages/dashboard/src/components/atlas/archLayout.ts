import type { ArchComponent, ArchEdge, ArchType, ArchZone } from "../../atlasTypes";

/**
 * Layout for the architecture diagram: zones as columns (a request reads left
 * to right), boxes ordered inside each column to keep arrows from crossing,
 * right-angled arrows with their own ports on each box, and label pills
 * placed where they don't collide.
 */

export const ZONE_ORDER: ArchZone[] = ["clients", "middleware", "checks", "routes", "services", "data"];
export const ZONE_LABEL: Record<ArchZone, string> = {
  clients: "Clients",
  middleware: "Middleware",
  checks: "Checks before your code",
  routes: "Route handlers",
  services: "Services",
  data: "Data & integrations",
};

/** Archify-style palette: one hue per role, readable on the dark canvas. */
export const TYPE_STYLE: Record<ArchType, { color: string; label: string; icon: string }> = {
  client: { color: "#22D3EE", label: "Clients", icon: "💻" },
  middleware: { color: "#94A3B8", label: "Middleware", icon: "⚙" },
  security: { color: "#FB7185", label: "Security", icon: "🔒" },
  gap: { color: "#F43F5E", label: "Missing safeguard", icon: "⚠" },
  backend: { color: "#34D399", label: "Route handlers", icon: "⟨⟩" },
  service: { color: "#2DD4BF", label: "Services", icon: "ƒ" },
  database: { color: "#A78BFA", label: "Database", icon: "🗄" },
  cache: { color: "#FB923C", label: "Cache", icon: "⚡" },
  external: { color: "#FBBF24", label: "Outside services", icon: "🌍" },
};

export const NODE_W = 196;
export const NODE_H = 64;
const GAP_X = 128;
const GAP_Y = 30;
const ZONE_PAD = 18;
const ZONE_TITLE = 26;
const MARGIN = 24;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeRoute {
  id: string;
  d: string;
  /** Points along the path, for animating a request along it. */
  points: Array<[number, number]>;
  label?: { x: number; y: number; text: string; w: number };
}

export interface ArchLayout {
  width: number;
  height: number;
  nodes: Map<string, Box>;
  zones: Array<{ id: ArchZone; label: string; box: Box }>;
  edges: Map<string, EdgeRoute>;
}

const TYPE_RANK: Record<ArchType, number> = {
  client: 0,
  middleware: 0,
  security: 1,
  gap: 2,
  backend: 0,
  service: 0,
  database: 0,
  cache: 1,
  external: 3,
};

export function labelWidth(text: string): number {
  return Math.round(text.length * 6.1 + 14);
}

/** Short text for an edge's pill: its first label, plus how many more. */
export function edgeText(e: Pick<ArchEdge, "labels">): string {
  const first = e.labels[0] ?? "";
  const clipped = first.length > 26 ? `${first.slice(0, 25)}…` : first;
  return e.labels.length > 1 ? `${clipped} +${e.labels.length - 1}` : clipped;
}

export function layoutArchitecture(components: ArchComponent[], edges: ArchEdge[], options: { labels?: boolean } = {}): ArchLayout {
  const zones = ZONE_ORDER.filter((z) => components.some((c) => c.zone === z));
  const col = new Map(zones.map((z, i) => [z, i]));
  const columns: ArchComponent[][] = zones.map((z) =>
    components.filter((c) => c.zone === z).sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.label.localeCompare(b.label)),
  );

  // Barycenter ordering: sweep left-to-right then right-to-left, each box pulled toward the boxes it
  // connects to in the column it's being ordered against (mixing both sides cancels the pull out).
  const colOf = new Map<string, number>();
  columns.forEach((c, i) => c.forEach((n) => colOf.set(n.id, i)));
  const neighbors = new Map<string, string[]>();
  for (const e of edges) {
    neighbors.set(e.from, [...(neighbors.get(e.from) ?? []), e.to]);
    neighbors.set(e.to, [...(neighbors.get(e.to) ?? []), e.from]);
  }
  const position = () => {
    const m = new Map<string, number>();
    for (const c of columns) c.forEach((n, i) => m.set(n.id, (i + 0.5) / c.length));
    return m;
  };
  for (let pass = 0; pass < 8; pass++) {
    const forwardPass = pass % 2 === 0;
    const order = forwardPass ? columns.map((_, i) => i).slice(1) : columns.map((_, i) => i).slice(0, -1).reverse();
    for (const ci of order) {
      const pos = position();
      const against = forwardPass ? ci - 1 : ci + 1;
      const score = new Map(
        columns[ci]!.map((n) => {
          // Nearest column on that side that this box actually connects to.
          const ns = (neighbors.get(n.id) ?? []).filter((x) => (forwardPass ? colOf.get(x)! < ci : colOf.get(x)! > ci));
          const nearest = ns.length ? (forwardPass ? Math.max(...ns.map((x) => colOf.get(x)!)) : Math.min(...ns.map((x) => colOf.get(x)!))) : against;
          const near = ns.filter((x) => colOf.get(x) === nearest);
          return [n.id, near.length ? near.reduce((sum, x) => sum + pos.get(x)!, 0) / near.length : pos.get(n.id)!];
        }),
      );
      columns[ci]!.sort((a, b) => score.get(a.id)! - score.get(b.id)! || TYPE_RANK[a.type] - TYPE_RANK[b.type]);
    }
  }

  const colHeight = (n: number) => n * NODE_H + (n - 1) * GAP_Y;
  const tallest = Math.max(...columns.map((c) => colHeight(c.length)));
  const top = MARGIN + ZONE_TITLE + ZONE_PAD;
  const nodes = new Map<string, Box>();
  const zoneBoxes: ArchLayout["zones"] = [];
  columns.forEach((c, i) => {
    const x = MARGIN + ZONE_PAD + i * (NODE_W + GAP_X);
    const y0 = top + (tallest - colHeight(c.length)) / 2;
    c.forEach((n, j) => nodes.set(n.id, { x, y: y0 + j * (NODE_H + GAP_Y), w: NODE_W, h: NODE_H }));
    zoneBoxes.push({
      id: zones[i]!,
      label: ZONE_LABEL[zones[i]!],
      box: { x: x - ZONE_PAD, y: MARGIN, w: NODE_W + ZONE_PAD * 2, h: tallest + ZONE_PAD * 2 + ZONE_TITLE },
    });
  });
  const width = MARGIN * 2 + zones.length * (NODE_W + ZONE_PAD * 2) + (zones.length - 1) * (GAP_X - ZONE_PAD * 2);
  const height = MARGIN * 2 + tallest + ZONE_PAD * 2 + ZONE_TITLE + 8;

  // Ports: each arrow gets its own spot along a box's side, in the order of the boxes at the other end.
  const drawable = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to);
  const forward = (e: ArchEdge) => col.get(zoneOf(components, e.to))! > col.get(zoneOf(components, e.from))!;
  const outPorts = new Map<string, ArchEdge[]>();
  const inPorts = new Map<string, ArchEdge[]>();
  for (const e of drawable) {
    outPorts.set(e.from, [...(outPorts.get(e.from) ?? []), e]);
    inPorts.set(e.to, [...(inPorts.get(e.to) ?? []), e]);
  }
  const portY = (box: Box, list: ArchEdge[], e: ArchEdge, other: (x: ArchEdge) => string) => {
    const sorted = [...list].sort((a, b) => nodes.get(other(a))!.y - nodes.get(other(b))!.y);
    const i = sorted.indexOf(e);
    return box.y + (box.h * (i + 1)) / (sorted.length + 1);
  };
  // Vertical channels in each gap between columns, one lane per arrow so they don't sit on top of each other.
  const lanes = new Map<number, number>();
  const laneX = (x0: number) => {
    const n = lanes.get(x0) ?? 0;
    lanes.set(x0, n + 1);
    const offset = ((n % 7) - 3) * 9;
    return x0 + GAP_X / 2 + offset;
  };

  const routes = new Map<string, EdgeRoute>();
  const placed: Box[] = [...nodes.values()];
  const collides = (b: Box) => placed.some((p) => b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y);
  const sortedEdges = [...drawable].sort((a, b) => b.routes.length - a.routes.length); // busiest arrows get the best label spots
  for (const e of sortedEdges) {
    const s = nodes.get(e.from)!;
    const t = nodes.get(e.to)!;
    let points: Array<[number, number]>;
    if (forward(e)) {
      const sy = portY(s, outPorts.get(e.from)!, e, (x) => x.to);
      const ty = portY(t, inPorts.get(e.to)!, e, (x) => x.from);
      const sx = s.x + s.w;
      const mx = laneX(sx);
      points = [
        [sx, sy],
        [mx, sy],
        [mx, ty],
        [t.x, ty],
      ];
    } else {
      // Same column (or backwards): a bracket out to the right.
      const sy = s.y + s.h / 2;
      const ty = t.y + t.h / 2;
      const bx = Math.max(s.x + s.w, t.x + t.w) + 14 + ((lanes.get(-s.x) ?? 0) % 3) * 8;
      lanes.set(-s.x, (lanes.get(-s.x) ?? 0) + 1);
      points = [
        [s.x + s.w, sy],
        [bx, sy],
        [bx, ty],
        [t.x + t.w, ty],
      ];
    }
    const d = points.map(([x, y], i) => `${i ? "L" : "M"}${Math.round(x)},${Math.round(y)}`).join(" ");
    const route: EdgeRoute = { id: e.id, d, points };
    if (options.labels !== false && e.labels.length) {
      const text = edgeText(e);
      const w = labelWidth(text);
      const [, sy] = points[0]!;
      const [mx, ty] = points[2]!;
      const candidates: Array<[number, number]> = [
        [mx, (sy + ty) / 2],
        [mx, sy + (ty - sy) * 0.25],
        [mx, sy + (ty - sy) * 0.75],
        [(mx + points[3]![0]) / 2, ty - 10],
        [(points[0]![0] + mx) / 2, sy - 10],
      ];
      for (const [cx, cy] of candidates) {
        const box = { x: cx - w / 2, y: cy - 9, w, h: 18 };
        if (!collides(box)) {
          placed.push(box);
          route.label = { x: cx, y: cy, text, w };
          break;
        }
      }
    }
    routes.set(e.id, route);
  }
  return { width, height, nodes, zones: zoneBoxes, edges: routes };
}

function zoneOf(components: ArchComponent[], id: string): ArchZone {
  return components.find((c) => c.id === id)?.zone ?? "services";
}

/** A point `t` (0..1) of the way along a polyline, for moving a dot along an arrow. */
export function pointAlong(points: Array<[number, number]>, t: number): [number, number] {
  const segs = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
  const total = segs.reduce((a, b) => a + b, 0);
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < segs.length; i++) {
    if (left <= segs[i]! || i === segs.length - 1) {
      const f = segs[i]! ? left / segs[i]! : 0;
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[i + 1]!;
      return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
    }
    left -= segs[i]!;
  }
  return points[points.length - 1]!;
}
