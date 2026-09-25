import { appendFileSync } from "node:fs";
import type { Finding } from "@acrv/core";

/** Escaping rules for GitHub Actions workflow commands (`::warning file=...::message`). */
export function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

const LEVEL: Record<Finding["severity"], "error" | "warning" | "notice"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "notice",
  none: "notice",
};

/**
 * Line annotations on the PR's "Files changed" tab. Workflow commands need no
 * token and work on fork PRs; GitHub shows at most 10 per level per step, so
 * the most severe findings go first.
 */
export function annotationCommands(findings: Finding[], limitPerLevel = 10): string[] {
  const order = ["critical", "high", "medium", "low", "none"];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const used = { error: 0, warning: 0, notice: 0 };
  const out: string[] = [];
  for (const f of sorted) {
    const level = LEVEL[f.severity];
    if (used[level] >= limitPerLevel) continue;
    used[level]++;
    const props = [`file=${escapeProperty(f.file)}`];
    if (f.line) props.push(`line=${f.line}`);
    props.push(`title=${escapeProperty(`[acrv] ${f.title}`.slice(0, 200))}`);
    const message = f.evidence ? `${f.detail}\n\n${f.evidence}` : f.detail;
    out.push(`::${level} ${props.join(",")}::${escapeData(message.slice(0, 2000))}`);
  }
  return out;
}

export function setOutput(name: string, value: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value.replace(/[\r\n]/g, " ")}\n`);
}

export function appendSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
