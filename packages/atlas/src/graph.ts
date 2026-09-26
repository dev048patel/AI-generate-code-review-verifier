import path from "node:path";
import { buildFlows } from "./flow.js";
import { isAuthRoute, joinPaths, normalizeRoutePath, resolveImport, routeId, routeMounts } from "./resolve.js";
import type {
  AtlasFinding,
  FileFacts,
  GraphEdge,
  GraphMetrics,
  GraphNode,
  RepoGraph,
} from "./types.js";

const ENTRY_RE =
  /(^|\/)(index|main|server|app|cli|worker|middleware|instrumentation|entry|bootstrap)\.[cm]?[jt]sx?$|(^|\/)(__)?fixtures(__)?\/|\.config\.[cm]?[jt]s$|(^|\/)(bin|scripts)\/|(^|\/)(pages|app)\/.*\.(t|j)sx?$|(^|\/)(vite|vitest|jest|webpack|rollup|eslint|next|tailwind|postcss|babel|playwright)\b/;

export function groupOf(file: string): string {
  const parts = file.split("/");
  if (parts.length === 1) return ".";
  if (["src", "packages", "apps", "lib", "libs", "services"].includes(parts[0]!) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0]!;
}

/**
 * Builds the repo map from per-file facts: modules, packages and HTTP routes
 * as nodes; imports and "route handled by module" as edges; plus the gaps
 * worth showing a developer.
 */
export function buildGraph(allFacts: FileFacts[], options: { commit?: string; entryFiles?: string[] } = {}): RepoGraph {
  const facts = allFacts.filter((f) => f.path);
  const files = new Set(facts.map((f) => f.path));
  const byPath = new Map(facts.map((f) => [f.path, f]));
  const entries = new Set(options.entryFiles ?? []);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const findings: AtlasFinding[] = [];
  const incoming = new Map<string, number>();

  const addEdge = (e: GraphEdge) => {
    const key = `${e.from}>${e.to}>${e.kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(e);
  };

  for (const f of facts) {
    nodes.set(`m:${f.path}`, { id: `m:${f.path}`, kind: "module", label: path.posix.basename(f.path), file: f.path, loc: f.loc, group: groupOf(f.path) });
  }

  // Imports.
  const moduleImports = new Map<string, Set<string>>();
  for (const f of facts) {
    const from = `m:${f.path}`;
    for (const imp of f.imports) {
      const r = resolveImport(f.path, imp.specifier, files);
      if (r.kind === "module") {
        const to = `m:${r.path}`;
        const target = byPath.get(r.path)!;
        const missing =
          imp.kind === "static" || imp.kind === "reexport"
            ? imp.names.filter((n) => !target.exportsStar && target.exports.length > 0 && !target.exports.includes(n))
            : [];
        addEdge({ from, to, kind: "import", ...(missing.length > 0 ? { broken: true } : {}) });
        incoming.set(to, (incoming.get(to) ?? 0) + 1);
        if (!imp.typeOnly) {
          if (!moduleImports.has(from)) moduleImports.set(from, new Set());
          moduleImports.get(from)!.add(to);
        }
        for (const name of missing) {
          findings.push({
            id: `broken-reference:${f.path}:${imp.specifier}:${name}`,
            kind: "broken-reference",
            severity: "high",
            title: `\`${name}\` is not exported by ${r.path}`,
            detail: `${f.path} imports \`${name}\` from "${imp.specifier}", but that module no longer exports it. This fails at build or run time.`,
            file: f.path,
            line: imp.line,
            nodeId: from,
          });
        }
      } else if (r.kind === "package") {
        const id = `p:${r.name}`;
        if (!nodes.has(id)) nodes.set(id, { id, kind: "package", label: r.name, group: "packages" });
        addEdge({ from, to: id, kind: "import" });
      } else if (r.kind === "missing") {
        findings.push({
          id: `broken-import:${f.path}:${imp.specifier}`,
          kind: "broken-import",
          severity: "high",
          title: `Import "${imp.specifier}" does not resolve`,
          detail: `${f.path} imports "${imp.specifier}", but no such file exists in the repo (was it moved, renamed or deleted?).`,
          file: f.path,
          line: imp.line,
          nodeId: from,
        });
      }
    }
  }

  const { prefixesOf } = routeMounts(facts, files);

  // Routes.
  for (const f of facts) {
    const prefixes = prefixesOf(f.path);
    for (const declared of f.routes) {
      for (const prefix of declared.framework === "express-like" ? prefixes : [""]) {
        const r = { ...declared, path: joinPaths(prefix, declared.path) };
        const id = routeId(r.method, r.path);
        if (!nodes.has(id)) {
          nodes.set(id, { id, kind: "route", label: `${r.method} ${r.path}`, file: f.path, line: r.line, group: "routes" });
        }
        addEdge({ from: id, to: `m:${f.path}`, kind: "handles" });
      }
    }
  }

  // Credential endpoints without rate limiting. The request flow decides, so the map, the flow view and
  // the findings always agree: it knows the middleware chain, limiters called inside the handler, and
  // endpoints that handle passwords whatever their path (e.g. sign-up at POST /users).
  let authRoutes = 0;
  let unprotected = 0;
  for (const flow of buildFlows(facts)) {
    const credential = isAuthRoute(flow) || flow.steps.some((s) => s.key === "missing:rate-limit");
    if (!credential) continue;
    authRoutes++;
    if (!flow.steps.some((s) => s.key === "missing:rate-limit")) continue;
    unprotected++;
    const proof = flow.steps.find((s) => s.kind === "security" && s.code);
    findings.push({
      id: `auth-route-no-rate-limit:${flow.method} ${normalizeRoutePath(flow.path)}`,
      kind: "auth-route-no-rate-limit",
      severity: "high",
      title: `${flow.method} ${flow.path} has no rate limiting`,
      detail:
        (isAuthRoute(flow) ? "This looks like a login / credential endpoint" : `This endpoint handles credentials (${proof?.code ?? "passwords"})`) +
        ", and no rate-limiting middleware applies to it, so it can be brute-forced or used for credential stuffing. " +
        "Add a limiter (e.g. express-rate-limit) on this route or its router.",
      file: flow.file,
      line: flow.line,
      nodeId: flow.routeId,
    });
  }

  // Import cycles (Tarjan's strongly connected components over runtime imports).
  const cycles = stronglyConnected(moduleImports).filter((c) => c.length > 1);
  for (const c of cycles) {
    const members = c.map((id) => id.slice(2)).sort();
    findings.push({
      id: `import-cycle:${members.join("|")}`,
      kind: "import-cycle",
      severity: "medium",
      title: `Import cycle between ${members.length} modules`,
      detail: `${members.slice(0, 6).join(" → ")}${members.length > 6 ? " → …" : ""}. Cycles cause undefined-at-import bugs and make modules impossible to change independently.`,
      file: members[0],
      nodeId: `m:${members[0]}`,
    });
  }

  // Modules nothing imports, that aren't entry points: probably dead code.
  let unusedModules = 0;
  for (const f of facts) {
    if (f.isTest || f.routes.length > 0 || entries.has(f.path) || ENTRY_RE.test(f.path)) continue;
    // No exports means it's run directly (build script, test setup, extension entry), not dead library code.
    if (f.exports.length === 0 && !f.exportsStar) continue;
    if ((incoming.get(`m:${f.path}`) ?? 0) > 0) continue;
    unusedModules++;
    findings.push({
      id: `unused-module:${f.path}`,
      kind: "unused-module",
      severity: "low",
      title: `${f.path} is not imported anywhere`,
      detail: "Nothing in the repo imports this module and it doesn't look like an entry point. If it's dead code, delete it; if it's new, it isn't wired in yet.",
      file: f.path,
      nodeId: `m:${f.path}`,
    });
  }

  const codeModules = facts.filter((f) => !f.isTest);
  const testModules = facts.length - codeModules.length;
  if (codeModules.length >= 10 && testModules === 0) {
    findings.push({
      id: "no-tests",
      kind: "no-tests",
      severity: "medium",
      title: "No test files",
      detail: `${codeModules.length} source modules and no *.test / *.spec files: nothing catches a regression before users do.`,
    });
  }

  const metrics: GraphMetrics = {
    modules: facts.length,
    testModules,
    loc: facts.reduce((n, f) => n + f.loc, 0),
    importEdges: edges.filter((e) => e.kind === "import").length,
    packages: [...nodes.values()].filter((n) => n.kind === "package").length,
    routes: [...nodes.values()].filter((n) => n.kind === "route").length,
    authRoutes,
    unprotectedAuthRoutes: unprotected,
    brokenImports: findings.filter((f) => f.kind === "broken-import" || f.kind === "broken-reference").length,
    unusedModules,
    cycles: cycles.length,
  };

  return { commit: options.commit, nodes: [...nodes.values()], edges, findings, metrics };
}

/** Tarjan's SCC, iterative so deep import chains can't overflow the stack. */
export function stronglyConnected(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const nodes = new Set<string>([...graph.keys(), ...[...graph.values()].flatMap((s) => [...s])]);

  for (const start of nodes) {
    if (indices.has(start)) continue;
    const work: Array<{ node: string; it: Iterator<string> }> = [];
    const open = (n: string) => {
      indices.set(n, index);
      low.set(n, index);
      index++;
      stack.push(n);
      onStack.add(n);
      work.push({ node: n, it: (graph.get(n) ?? new Set<string>()).values() });
    };
    open(start);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const next = top.it.next();
      if (!next.done) {
        const w = next.value;
        if (!indices.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.node, Math.min(low.get(top.node)!, indices.get(w)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) === indices.get(top.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.node);
        out.push(comp);
      }
    }
  }
  return out;
}
