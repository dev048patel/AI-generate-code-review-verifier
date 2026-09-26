import { summarizeDiff } from "./diff.js";
import type { AtlasFinding, FlowDiff, FlowStep, GraphDiff, HistoryAnalysis, RepoGraph, RequestFlow } from "./types.js";

const ICON: Record<AtlasFinding["severity"], string> = { critical: "✖", high: "✖", medium: "▲", low: "•", info: "•" };

function finding(f: AtlasFinding): string {
  const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  return `  ${ICON[f.severity]} [${f.severity}] ${f.title}${loc}`;
}

/** Plain-text report of a change, for terminals and CI logs. */
export function renderDiffText(d: GraphDiff, label = "this change"): string {
  const lines = [`Impact of ${label}: ${summarizeDiff(d)}`];
  const routes = (list: GraphDiff["addedNodes"]) => list.filter((n) => n.kind === "route").map((n) => n.label);
  const added = routes(d.addedNodes);
  const removed = routes(d.removedNodes);
  if (added.length) lines.push("", "Routes added:", ...added.map((r) => `  + ${r}`));
  if (removed.length) lines.push("", "Routes removed:", ...removed.map((r) => `  - ${r}`));
  const deps = d.addedNodes.filter((n) => n.kind === "package").map((n) => n.label);
  if (deps.length) lines.push("", "New dependencies:", ...deps.map((p) => `  + ${p}`));
  if (d.newFindings.length) lines.push("", "Introduced by this change:", ...d.newFindings.map(finding));
  if (d.resolvedFindings.length) lines.push("", "Fixed by this change:", ...d.resolvedFindings.map(finding));
  return lines.join("\n");
}

export function renderGraphText(g: RepoGraph): string {
  const m = g.metrics;
  return [
    `${m.modules} modules (${m.testModules} tests), ${m.loc.toLocaleString()} lines, ${m.importEdges} import links, ${m.packages} packages, ${m.routes} routes`,
    ...(g.findings.length ? ["", "Findings:", ...g.findings.slice(0, 40).map(finding)] : ["", "No findings."]),
  ].join("\n");
}

export function renderHistoryText(a: HistoryAnalysis): string {
  const first = a.commits[0]!;
  const last = a.commits[a.commits.length - 1]!;
  const lines = [
    `${a.commits.length} commits (${first.sha.slice(0, 7)} … ${last.sha.slice(0, 7)})${a.truncated ? " [truncated to 5000 files]" : ""}`,
    `Modules ${first.metrics.modules} → ${last.metrics.modules}, routes ${first.metrics.routes} → ${last.metrics.routes}, ` +
      `lines ${first.metrics.loc.toLocaleString()} → ${last.metrics.loc.toLocaleString()}`,
    `Thrown away within ${a.waste.windowCommits} commits: ${a.waste.shortLivedLines} of ${a.waste.addedLines} added lines (~${a.waste.estimatedTokens.toLocaleString()} tokens)`,
  ];
  const regressions = a.commits.filter((c) => c.delta.newFindings.length > 0);
  if (regressions.length) {
    lines.push("", "Commits that introduced problems:");
    for (const c of regressions.slice(-10)) lines.push(`  ${c.sha.slice(0, 7)} ${c.subject.slice(0, 60)} → ${c.delta.newFindings.length} new`);
  }
  if (a.hotspots.length) {
    lines.push("", "Hotspots:", ...a.hotspots.slice(0, 5).map((h) => `  ${h.file}: ${h.commits} commits, ${h.churn} lines churned, ${h.loc} lines`));
  }
  if (a.recommendations.length) {
    lines.push("", "Recommendations:", ...a.recommendations.map((r) => `  [${r.priority}] ${r.title}`));
  }
  return lines.join("\n");
}

function stepLine(s: FlowStep, n: number | undefined, mark = " "): string {
  const indent = "   ".repeat(s.depth);
  const num = n === undefined ? "  " : `${String(n).padStart(2)}.`;
  const icon = s.kind === "missing" ? "⚠ " : "";
  const where = s.file ? `  ${s.file}${s.line ? `:${s.line}` : ""}` : "";
  const code = s.code && s.kind !== "call" && s.kind !== "handler" ? `  [${s.code}]` : "";
  return `${mark} ${num} ${indent}${icon}${s.title}${code}${where}`;
}

/** One request, step by step. */
export function renderFlowText(flow: RequestFlow, options: { explain?: boolean } = {}): string {
  const lines = [`${flow.method} ${flow.path}   (${flow.file}:${flow.line})`, ""];
  flow.steps.forEach((s, i) => {
    lines.push(stepLine(s, i + 1));
    if (options.explain) lines.push(`       ${"   ".repeat(s.depth)}${s.explain}`);
  });
  return lines.join("\n");
}

/** Every request whose path through the code changed. */
export function renderFlowDiffText(diffs: FlowDiff[]): string {
  const changed = diffs.filter((d) => d.status !== "same");
  if (changed.length === 0) return "No request changed how it flows through the code.";
  const lines = [`${changed.length} request(s) flow differently:`];
  for (const d of changed) {
    lines.push("", `${d.status === "added" ? "+" : d.status === "removed" ? "−" : "~"} ${d.label}: ${d.summary}`);
    if (d.status !== "changed") continue;
    for (const s of d.steps) if (s.change !== "same") lines.push(stepLine(s, undefined, s.change === "added" ? "+" : "−"));
  }
  return lines.join("\n");
}
