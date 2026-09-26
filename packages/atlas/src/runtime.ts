import { routeId } from "./resolve.js";
import type { RepoGraph } from "./types.js";

/**
 * Live view: how the parts of a running app talk to each other and how long
 * it takes. Input is standard OpenTelemetry trace data (OTLP/HTTP JSON), so
 * any app instrumented with OpenTelemetry can point its exporter here --
 * nothing custom to install.
 */

interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number | string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes?: Array<{ key: string; value: OtlpValue }>;
  status?: { code?: number | string };
}
export interface OtlpTraces {
  resourceSpans?: Array<{
    resource?: { attributes?: Array<{ key: string; value: OtlpValue }> };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

export interface RuntimeNode {
  id: string;
  kind: "route" | "external" | "database" | "internal" | "service";
  label: string;
  calls: number;
  errors: number;
}

export interface RuntimeEdge {
  from: string;
  to: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
}

export interface RuntimeSnapshot {
  nodes: RuntimeNode[];
  edges: RuntimeEdge[];
  spans: number;
  windowStart?: number;
  windowEnd?: number;
}

function attr(span: { attributes?: Array<{ key: string; value: OtlpValue }> }, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = span.attributes?.find((a) => a.key === k)?.value;
    if (!v) continue;
    const s = v.stringValue ?? (v.intValue !== undefined ? String(v.intValue) : v.doubleValue !== undefined ? String(v.doubleValue) : undefined);
    if (s !== undefined) return s;
  }
  return undefined;
}

const SPAN_KIND_SERVER = new Set([2, "2", "SPAN_KIND_SERVER"]);
const SPAN_KIND_CLIENT = new Set([3, "3", "SPAN_KIND_CLIENT"]);

/** Maps a span onto the same node ids the static map uses, so the two views overlay. */
export function spanNode(span: OtlpSpan, service: string): { id: string; kind: RuntimeNode["kind"]; label: string } {
  const method = attr(span, "http.request.method", "http.method");
  const route = attr(span, "http.route");
  if (SPAN_KIND_SERVER.has(span.kind ?? "") && route) {
    return { id: routeId((method ?? "ALL").toUpperCase(), route), kind: "route", label: `${(method ?? "").toUpperCase()} ${route}`.trim() };
  }
  const db = attr(span, "db.system", "db.system.name");
  if (db) return { id: `db:${db}`, kind: "database", label: db };
  if (SPAN_KIND_CLIENT.has(span.kind ?? "")) {
    const url = attr(span, "url.full", "http.url");
    let host = attr(span, "server.address", "net.peer.name");
    if (!host && url) {
      try {
        host = new URL(url).host;
      } catch {
        /* ignore */
      }
    }
    if (host) return { id: `ext:${host}`, kind: "external", label: host };
  }
  if (SPAN_KIND_SERVER.has(span.kind ?? "")) return { id: `svc:${service}`, kind: "service", label: service };
  return { id: `fn:${service}:${span.name}`, kind: "internal", label: span.name };
}

const MAX_SAMPLES = 1000;

/**
 * Rolling aggregation of spans into a call graph with latency percentiles.
 * Durations are child-span durations, i.e. how long the caller waited on the callee.
 */
export class RuntimeAggregator {
  private nodes = new Map<string, RuntimeNode>();
  private edges = new Map<string, { from: string; to: string; calls: number; errors: number; samples: number[]; total: number }>();
  private spanCount = 0;
  private windowStart?: number;
  private windowEnd?: number;

  ingest(payload: OtlpTraces): number {
    let n = 0;
    for (const rs of payload.resourceSpans ?? []) {
      const service = attr(rs.resource ?? {}, "service.name") ?? "app";
      const spans = (rs.scopeSpans ?? []).flatMap((s) => s.spans ?? []);
      const byId = new Map(spans.map((s) => [s.spanId, s]));
      for (const span of spans) {
        n++;
        const node = spanNode(span, service);
        const error = String(span.status?.code) === "2" || span.status?.code === "STATUS_CODE_ERROR";
        const existing = this.nodes.get(node.id) ?? { ...node, calls: 0, errors: 0 };
        existing.calls++;
        if (error) existing.errors++;
        this.nodes.set(node.id, existing);

        const start = Number(span.startTimeUnixNano) / 1e6;
        const end = Number(span.endTimeUnixNano) / 1e6;
        this.windowStart = Math.min(this.windowStart ?? start, start);
        this.windowEnd = Math.max(this.windowEnd ?? end, end);

        const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
        if (!parent) continue;
        const from = spanNode(parent, service).id;
        if (from === node.id) continue;
        const key = `${from}>${node.id}`;
        const e = this.edges.get(key) ?? { from, to: node.id, calls: 0, errors: 0, samples: [], total: 0 };
        const ms = Math.max(0, end - start);
        e.calls++;
        e.total += ms;
        if (error) e.errors++;
        if (e.samples.length < MAX_SAMPLES) e.samples.push(ms);
        else e.samples[Math.floor(Math.random() * MAX_SAMPLES)] = ms; // reservoir-ish: keep percentiles current
        this.edges.set(key, e);
      }
    }
    this.spanCount += n;
    return n;
  }

  snapshot(): RuntimeSnapshot {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()].map((e) => {
        const sorted = [...e.samples].sort((a, b) => a - b);
        const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0);
        return { from: e.from, to: e.to, calls: e.calls, errors: e.errors, p50Ms: round(pct(0.5)), p95Ms: round(pct(0.95)), avgMs: round(e.total / e.calls) };
      }),
      spans: this.spanCount,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface RuntimeCoverage {
  /** Routes in the code that received no traffic in the window. */
  neverCalled: string[];
  /** Routes seen at runtime that the static map doesn't know (dynamic routing, or code not in this repo). */
  unknownAtRuntime: string[];
  slowest: RuntimeEdge[];
  failing: RuntimeEdge[];
}

/** Compares what the code declares with what actually runs. */
export function compareRuntime(graph: RepoGraph, runtime: RuntimeSnapshot): RuntimeCoverage {
  const staticRoutes = new Set(graph.nodes.filter((n) => n.kind === "route").map((n) => n.id));
  const liveRoutes = new Set(runtime.nodes.filter((n) => n.kind === "route").map((n) => n.id));
  const matches = (id: string, set: Set<string>) =>
    set.has(id) || set.has(id.replace(/^r:\w+ /, "r:ALL ")) || [...set].some((s) => s.replace(/^r:\w+ /, "r:ALL ") === id.replace(/^r:\w+ /, "r:ALL "));
  return {
    neverCalled: [...staticRoutes].filter((id) => !matches(id, liveRoutes)).map((id) => id.slice(2)),
    unknownAtRuntime: [...liveRoutes].filter((id) => !matches(id, staticRoutes)).map((id) => id.slice(2)),
    slowest: [...runtime.edges].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 5),
    failing: runtime.edges.filter((e) => e.errors > 0).sort((a, b) => b.errors / b.calls - a.errors / a.calls).slice(0, 5),
  };
}
