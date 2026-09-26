import type { AtlasFinding, GraphDiff, GraphEdge, GraphMetrics, RepoGraph } from "./types.js";

const edgeKey = (e: GraphEdge) => `${e.from}>${e.to}>${e.kind}`;

/**
 * What a change does to the map: nodes/edges added and removed, findings it
 * introduced ("worked before, broken now") or resolved, and metric deltas.
 * Routes that disappear are reported as findings too -- a removed endpoint is
 * the classic "this used to work" regression for API clients.
 */
export function diffGraphs(before: RepoGraph, after: RepoGraph): GraphDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const afterEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));

  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));
  const beforeFindings = new Map(before.findings.map((f) => [f.id, f]));
  const afterFindings = new Map(after.findings.map((f) => [f.id, f]));

  const newFindings: AtlasFinding[] = after.findings.filter((f) => !beforeFindings.has(f.id));
  const addedRoutes = after.nodes.filter((n) => n.kind === "route" && !beforeNodes.has(n.id));
  for (const n of removedNodes) {
    if (n.kind !== "route") continue;
    // Same method, same tail, now under a prefix (router remounted): moved, not removed.
    const [method, oldPath] = n.id.slice(2).split(" ") as [string, string];
    const moved = addedRoutes.some((a) => {
      const [m, p] = a.id.slice(2).split(" ") as [string, string];
      return m === method && oldPath !== "/" && p !== "/" && (p.endsWith(oldPath) || oldPath.endsWith(p));
    });
    if (moved) continue;
    newFindings.push({
      id: `route-removed:${n.label}`,
      kind: "route-removed",
      severity: "medium",
      title: `${n.label} was removed`,
      detail: `This endpoint existed in ${n.file ?? "the previous version"} and is gone now. Any client still calling it will get 404s.`,
      file: n.file,
      line: n.line,
      nodeId: n.id,
    });
  }
  // An edge that was fine and is now broken is a regression even if the finding id already existed elsewhere.
  for (const e of after.edges) {
    const prev = beforeEdges.get(edgeKey(e));
    if (e.broken && prev && !prev.broken && !newFindings.some((f) => f.nodeId === e.from && f.kind === "broken-reference")) {
      newFindings.push({
        id: `broken-edge:${e.from}>${e.to}`,
        kind: "broken-reference",
        severity: "high",
        title: `${e.from.slice(2)} now imports something ${e.to.slice(2)} no longer exports`,
        detail: "This import resolved before this change and is broken after it.",
        file: e.from.slice(2),
        nodeId: e.from,
      });
    }
  }

  const metricsDelta: Partial<Record<keyof GraphMetrics, number>> = {};
  for (const key of Object.keys(after.metrics) as Array<keyof GraphMetrics>) {
    const d = after.metrics[key] - (before.metrics[key] ?? 0);
    if (d !== 0) metricsDelta[key] = d;
  }

  return {
    from: before.commit,
    to: after.commit,
    addedNodes: after.nodes.filter((n) => !beforeNodes.has(n.id)),
    removedNodes,
    addedEdges: after.edges.filter((e) => !beforeEdges.has(edgeKey(e))),
    removedEdges: before.edges.filter((e) => !afterEdges.has(edgeKey(e))),
    newFindings,
    resolvedFindings: before.findings.filter((f) => !afterFindings.has(f.id)),
    metricsDelta,
  };
}

/** One-paragraph plain-language summary for PR comments, the extension panel and the CLI. */
export function summarizeDiff(d: GraphDiff): string {
  const parts: string[] = [];
  const mods = (list: typeof d.addedNodes) => list.filter((n) => n.kind === "module").length;
  const routes = (list: typeof d.addedNodes) => list.filter((n) => n.kind === "route").length;
  if (mods(d.addedNodes) || mods(d.removedNodes)) parts.push(`${mods(d.addedNodes)} module(s) added, ${mods(d.removedNodes)} removed`);
  if (routes(d.addedNodes) || routes(d.removedNodes)) parts.push(`${routes(d.addedNodes)} route(s) added, ${routes(d.removedNodes)} removed`);
  if (d.addedEdges.length || d.removedEdges.length) parts.push(`${d.addedEdges.length} dependency link(s) added, ${d.removedEdges.length} removed`);
  const bad = d.newFindings.filter((f) => f.severity === "critical" || f.severity === "high");
  if (bad.length) parts.push(`${bad.length} new high-severity problem(s)`);
  if (d.resolvedFindings.length) parts.push(`${d.resolvedFindings.length} problem(s) fixed`);
  return parts.length ? parts.join("; ") + "." : "No structural change.";
}
