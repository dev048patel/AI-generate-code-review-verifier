import path from "node:path";
import type { FlowStep, RequestFlow } from "./types.js";

/**
 * An architecture diagram generated from request flows: the parts of the
 * system as boxes in zones (clients -> checks -> route handlers -> services
 * -> data & integrations), labelled arrows for what passes between them, and
 * one "story" per request that lights up its path. Every box points back to
 * the code it came from. Missing safeguards are boxes too, drawn where they
 * should be, so the path of an unprotected login visibly runs through a gap.
 */

export type ArchType = "client" | "security" | "gap" | "middleware" | "backend" | "service" | "database" | "cache" | "external";

export type ArchZone = "clients" | "middleware" | "checks" | "routes" | "services" | "data";

export interface ArchSource {
  file: string;
  line?: number;
  label?: string;
}

export interface ArchComponent {
  id: string;
  type: ArchType;
  zone: ArchZone;
  label: string;
  sublabel?: string;
  /** Short badge: "missing", "3 routes", "validates input". */
  tag?: string;
  sources: ArchSource[];
  /** Requests (route ids) that pass through this part. */
  routes: string[];
}

export interface ArchEdge {
  id: string;
  from: string;
  to: string;
  /** What travels along it: "POST /api/users/login", "findUnique user", "bcrypt.compare". */
  labels: string[];
  kind: "request" | "call" | "data";
  routes: string[];
}

export interface ArchHop {
  from: string;
  to: string;
  label: string;
  kind: "request" | "call" | "data" | "return" | "gap";
  /** Plain-English note for the story caption. */
  note: string;
  /** The flow step this hop narrates (for linking back to the step list). */
  stepKey: string;
}

export interface ArchStory {
  id: string;
  routeId: string;
  label: string;
  /** "Unprotected login", "Signs up a user". */
  title: string;
  /** Worst gap on this path, if any. */
  severity?: FlowStep["severity"];
  hops: ArchHop[];
  components: string[];
}

export interface Architecture {
  components: ArchComponent[];
  edges: ArchEdge[];
  stories: ArchStory[];
}

export const ZONES: Array<{ id: ArchZone; label: string }> = [
  { id: "clients", label: "Clients" },
  { id: "middleware", label: "Middleware" },
  { id: "checks", label: "Checks before your code" },
  { id: "routes", label: "Route handlers" },
  { id: "services", label: "Services" },
  { id: "data", label: "Data & integrations" },
];

const SECURITY_MIDDLEWARE = /^(Rate limiter|Sign-in check|Permission check|CSRF check|Same-origin check|Loads the session|Checks the input)$/;

function humanize(file: string): string {
  let base = path.posix.basename(file).replace(/\.[cm]?[jt]sx?$/, "");
  if (/^(index|route|handler|main|app|server)$/.test(base)) {
    const dir = path.posix.basename(path.posix.dirname(file));
    base = !dir || dir === "." || /^(src|app|lib|server|api)$/.test(dir) ? "app" : dir;
  }
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._\-\s]+/)
    .filter(Boolean);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The model a database call touches: prisma.user.findUnique -> "user", Comment.find.remove -> "comment". */
function dbModel(code: string): string | undefined {
  const segs = code.replace(/^this\./, "").split(".");
  if (segs.length >= 3) return segs[1]!.replace(/(Repository|Repo|Model)$/i, "").toLowerCase() || undefined;
  const root = segs[0]!;
  if (/^[A-Z]/.test(root)) return root.replace(/(Repository|Repo|Model)$/, "").toLowerCase();
  if (/(repo|repository|model)$/i.test(root)) return root.replace(/(Repository|Repo|Model)$/i, "").toLowerCase() || undefined;
  return undefined;
}

function dbVerb(step: FlowStep): string {
  const m = /^(Looks up|Saves|Updates|Deletes|Queries|Runs|Uses)/.exec(step.title);
  return ({ "Looks up": "read", Saves: "write", Updates: "update", Deletes: "delete", Queries: "query", Runs: "transaction", Uses: "use" } as Record<string, string>)[m?.[1] ?? "Uses"]!;
}

function securityComponent(step: FlowStep): { id: string; label: string; sublabel: string } {
  const t = step.title;
  if (/password/i.test(t)) return { id: "sec:passwords", label: "Password hashing", sublabel: (step.code ?? "").split(".")[0] ?? "" };
  if (/token/i.test(t)) return { id: "sec:tokens", label: "Login tokens", sublabel: (step.code ?? "").split(".")[0] ?? "" };
  if (/signed-in user|credentials/i.test(t)) return { id: "sec:session", label: "Session / identity", sublabel: step.code ?? "" };
  if (/rate limit/i.test(t)) return { id: "mw:rate-limiter", label: "Rate limiter", sublabel: step.code ?? "" };
  return { id: "sec:crypto", label: "Crypto", sublabel: step.code ?? "" };
}

class Builder {
  components = new Map<string, ArchComponent>();
  edges = new Map<string, ArchEdge>();
  private subs = new Map<string, Set<string>>();

  comp(id: string, init: Omit<ArchComponent, "id" | "sources" | "routes">, routeId: string, source?: ArchSource, sub?: string): string {
    let c = this.components.get(id);
    if (!c) {
      c = { id, ...init, sources: [], routes: [] };
      this.components.set(id, c);
    }
    if (!c.routes.includes(routeId)) c.routes.push(routeId);
    if (source && c.sources.length < 8 && !c.sources.some((s) => s.file === source.file && s.line === source.line)) c.sources.push(source);
    if (sub) {
      const set = this.subs.get(id) ?? new Set();
      set.add(sub);
      this.subs.set(id, set);
    }
    return id;
  }

  edge(from: string, to: string, label: string, kind: ArchEdge["kind"], routeId: string): void {
    if (from === to) return;
    const id = `${from}>${to}`;
    const e = this.edges.get(id) ?? { id, from, to, labels: [], kind, routes: [] };
    if (label && !e.labels.includes(label)) e.labels.push(label);
    if (!e.routes.includes(routeId)) e.routes.push(routeId);
    this.edges.set(id, e);
  }

  finish(): void {
    for (const [id, set] of this.subs) {
      const c = this.components.get(id)!;
      const items = [...set].filter(Boolean);
      if (items.length) c.sublabel = items.slice(0, 4).join(" · ") + (items.length > 4 ? ` +${items.length - 4}` : "");
    }
  }
}

function storyTitle(flow: RequestFlow): string {
  const t = flow.steps.map((s) => s.title);
  const gap = flow.steps.find((s) => s.kind === "missing" && (s.severity === "high" || s.severity === "critical"));
  const what = t.includes("Checks the password")
    ? "Logs a user in"
    : t.includes("Hashes the password")
      ? t.includes("Sign-in check")
        ? "Changes account details"
        : "Signs a user up"
      : t.some((x) => /^Deletes/.test(x))
        ? "Deletes data"
        : t.some((x) => /^(Saves|Updates)/.test(x))
          ? "Changes data"
          : t.some((x) => /^Calls (?!.*\(\))/.test(x))
            ? "Calls another service"
            : t.some((x) => /^Looks up|^Queries/.test(x))
              ? "Reads data"
              : "Handles a request";
  return gap ? `${what}: ${gap.title.toLowerCase()}` : what;
}

/** The architecture of the whole app, derived from every request's flow. */
export function buildArchitecture(flows: RequestFlow[]): Architecture {
  const b = new Builder();
  const stories: ArchStory[] = [];

  for (const flow of flows) {
    const r = flow.routeId;
    const request = `${flow.method} ${flow.path}`;
    const hops: ArchHop[] = [];
    const touched = new Set<string>();
    const hop = (h: ArchHop) => {
      if (h.from === h.to) return;
      hops.push(h);
      touched.add(h.from);
      touched.add(h.to);
    };

    const client = b.comp("client", { type: "client", zone: "clients", label: "Clients", sublabel: "browser · app · script" }, r);
    let prev = client;
    /** stack[d] = the code component running at depth d. */
    const stack: string[] = [];
    const callerAt = (depth: number) => stack[Math.min(depth, stack.length - 1)] ?? prev;

    for (const s of flow.steps) {
      const src = s.file ? { file: s.file, line: s.line, label: s.code ?? s.title } : undefined;
      switch (s.kind) {
        case "client":
          break;
        case "middleware": {
          const security = SECURITY_MIDDLEWARE.test(s.title);
          const id = security
            ? b.comp(`mw:${slug(s.title)}`, { type: "security", zone: "checks", label: s.title }, r, src, s.code)
            : b.comp("mw:pipeline", { type: "middleware", zone: "middleware", label: "Middleware" }, r, src, s.title.replace(/^Reads the request body$/, "body parser").replace(/^Runs /, ""));
          b.edge(prev, id, request, "request", r);
          hop({ from: prev, to: id, label: request, kind: "request", note: `${s.title}: ${s.explain}`, stepKey: s.key });
          prev = id;
          break;
        }
        case "missing": {
          if (s.key === "missing:validation") break; // shown as a tag on the handler, not a box
          const what = s.key.replace(/^missing:/, "");
          const id = b.comp(`gap:${what}`, { type: "gap", zone: "checks", label: s.title, tag: "missing" }, r);
          b.edge(prev, id, request, "request", r);
          hop({ from: prev, to: id, label: request, kind: "gap", note: `⚠ ${s.title}: ${s.explain}`, stepKey: s.key });
          prev = id;
          break;
        }
        case "handler": {
          const file = s.file ?? flow.file;
          const id = b.comp(`code:${file}`, { type: "backend", zone: "routes", label: humanize(file) }, r, { file, line: s.line, label: s.title }, request);
          b.edge(prev, id, request, "request", r);
          hop({ from: prev, to: id, label: request, kind: "request", note: `${s.title}: ${s.explain}`, stepKey: s.key });
          stack.length = 0;
          stack.push(id);
          break;
        }
        case "call": {
          const caller = callerAt(s.depth);
          const file = s.file ?? flow.file;
          const fn = s.title.replace(/^Calls /, "");
          // Helpers a service calls (mappers, utils) are part of that service at this level of detail:
          // their database / token / API work is drawn as the service's own.
          if (b.components.get(caller)?.zone === "services") {
            b.comp(caller, { type: "service", zone: "services", label: "" }, r, { file, line: s.line, label: fn });
            stack.length = s.depth + 1;
            stack.push(caller);
            break;
          }
          const isRoute = b.components.get(`code:${file}`)?.zone === "routes";
          const id =
            `code:${file}` === caller || isRoute
              ? b.comp(`code:${file}`, { type: "backend", zone: "routes", label: humanize(file) }, r, { file, line: s.line, label: fn })
              : b.comp(`code:${file}`, { type: "service", zone: "services", label: humanize(file) }, r, { file, line: s.line, label: fn }, fn.replace(/\(\)$/, ""));
          b.edge(caller, id, fn, "call", r);
          hop({ from: caller, to: id, label: fn, kind: "call", note: `${s.title}: ${s.explain}`, stepKey: s.key });
          stack.length = s.depth + 1;
          stack.push(id);
          break;
        }
        case "database": {
          const caller = callerAt(s.depth);
          const cache = /^(redis|cache)/i.test(s.code ?? "");
          const model = dbModel(s.code ?? "");
          const id = cache
            ? b.comp("db:cache", { type: "cache", zone: "data", label: "Cache", sublabel: "redis" }, r, src)
            : b.comp("db:main", { type: "database", zone: "data", label: "Database" }, r, src, model);
          const label = `${dbVerb(s)}${model ? ` ${model}` : ""}`;
          b.edge(caller, id, label, "data", r);
          hop({ from: caller, to: id, label, kind: "data", note: `${s.title}: ${s.explain}`, stepKey: s.key });
          break;
        }
        case "security": {
          const caller = callerAt(s.depth);
          const sec = securityComponent(s);
          const id = b.comp(sec.id, { type: "security", zone: sec.id.startsWith("mw:") ? "checks" : "data", label: sec.label }, r, src, sec.sublabel);
          b.edge(caller, id, s.code ?? s.title, "call", r);
          hop({ from: caller, to: id, label: s.code ?? s.title, kind: "call", note: `${s.title}: ${s.explain}`, stepKey: s.key });
          break;
        }
        case "external": {
          const caller = callerAt(s.depth);
          const host = /^Calls (.+)$/.exec(s.title)?.[1] ?? "outside service";
          const id = b.comp(`ext:${slug(host)}`, { type: "external", zone: "data", label: host }, r, src, s.code);
          b.edge(caller, id, s.code ?? "request", "call", r);
          hop({ from: caller, to: id, label: s.code ?? "request", kind: "call", note: `${s.title}: ${s.explain}`, stepKey: s.key });
          break;
        }
        case "response":
        case "error": {
          const from = callerAt(s.depth);
          const label =
            s.title === "Passes an error on"
              ? "error"
              : s.title.replace(/^(Sends back|Rejects with|Fails with|Stops with) /, "").replace(/^Redirects /, "redirect ");
          hop({ from, to: client, label, kind: "return", note: `${s.title}: ${s.explain}`, stepKey: s.key });
          break;
        }
        default:
          break;
      }
    }

    // Handlers that use input without checking it get a tag rather than a box.
    if (flow.steps.some((s) => s.key === "missing:validation")) {
      const h = stack[0] ? b.components.get(stack[0]) : undefined;
      if (h) h.tag = "unchecked input";
    }
    const gaps = flow.steps.filter((s) => s.kind === "missing");
    const order = ["critical", "high", "medium", "low", "info"] as const;
    const severity = order.find((sev) => gaps.some((g) => g.severity === sev));
    stories.push({ id: slug(request), routeId: r, label: request, title: storyTitle(flow), ...(severity ? { severity } : {}), hops, components: [...touched] });
  }

  b.finish();
  for (const c of b.components.values()) {
    if (c.zone === "routes" && !c.tag) c.tag = `${c.routes.length} route${c.routes.length === 1 ? "" : "s"}`;
  }
  // Worst gaps first, then the richest stories: the ones worth playing.
  const rank = (s: ArchStory) => (s.severity === "critical" || s.severity === "high" ? 0 : s.severity ? 1 : 2);
  stories.sort((x, y) => rank(x) - rank(y) || y.components.length - x.components.length || x.label.localeCompare(y.label));
  return { components: [...b.components.values()], edges: [...b.edges.values()], stories };
}

export type ArchStatus = "added" | "removed" | "same";

export interface ArchitectureDiff {
  components: Array<ArchComponent & { status: ArchStatus }>;
  edges: Array<ArchEdge & { status: ArchStatus }>;
  /** "+ Password hashing; − Rate limiter; + api.stripe.com". */
  summary: string[];
}

/** Both versions on one diagram: what a change adds, removes or leaves alone. */
export function diffArchitecture(before: Architecture, after: Architecture): ArchitectureDiff {
  const bc = new Map(before.components.map((c) => [c.id, c]));
  const ac = new Map(after.components.map((c) => [c.id, c]));
  const be = new Map(before.edges.map((e) => [e.id, e]));
  const ae = new Map(after.edges.map((e) => [e.id, e]));
  const components = [
    ...after.components.map((c) => ({ ...c, status: (bc.has(c.id) ? "same" : "added") as ArchStatus })),
    ...before.components.filter((c) => !ac.has(c.id)).map((c) => ({ ...c, status: "removed" as ArchStatus })),
  ];
  const edges = [
    ...after.edges.map((e) => ({ ...e, status: (be.has(e.id) ? "same" : "added") as ArchStatus })),
    ...before.edges.filter((e) => !ae.has(e.id)).map((e) => ({ ...e, status: "removed" as ArchStatus })),
  ];
  const summary = components
    .filter((c) => c.status !== "same")
    .sort((x, y) => Number(y.type === "gap") - Number(x.type === "gap"))
    .map((c) => (c.type === "gap" ? `${c.status === "added" ? "⚠ now" : "fixed"}: ${c.label.toLowerCase()}` : `${c.status === "added" ? "+" : "−"} ${c.label}`));
  return { components, edges, summary };
}
