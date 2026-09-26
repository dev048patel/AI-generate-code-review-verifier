import type { CommitPoint } from "../atlasTypes";

/**
 * Estimated AI spend behind a repository's history. Git records no tokens,
 * so this is a model with visible, adjustable assumptions, not a bill:
 *
 *   written tokens = code characters added / chars-per-token
 *   read tokens    = written tokens × context read per token written
 *                    (an agent reads files, diffs and its own history far
 *                    more than it writes; most of that is served from cache)
 *   cost           = written × output price
 *                  + read × (cached share × cache price + rest × input price)
 *
 * Which commits count is a choice too: only commits marked as AI-written
 * (co-author trailers etc.), or every non-bot commit ("if all of it had been
 * written with an AI assistant").
 */

export interface ModelPrice {
  id: string;
  label: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
}

// Anthropic first-party API prices (per million tokens).
export const MODEL_PRICES: ModelPrice[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2 },
  { id: "claude-opus-5", label: "Claude Opus 5", input: 5, output: 25, cacheRead: 0.5 },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", input: 2, output: 10, cacheRead: 0.2 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", input: 1, output: 5, cacheRead: 0.1 },
];

export interface Assumptions {
  model: ModelPrice;
  charsPerToken: number;
  /** Input tokens read per output token written. */
  readPerWritten: number;
  /** Share of read tokens served from the prompt cache. */
  cachedShare: number;
  scope: "marked" | "all";
}

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  model: MODEL_PRICES[0]!,
  charsPerToken: 4,
  readPerWritten: 20,
  cachedShare: 0.8,
  scope: "marked",
};

export interface Usage {
  written: number;
  read: number;
  usd: number;
}

export function usageOfChars(chars: number, a: Assumptions): Usage {
  const written = chars / a.charsPerToken;
  const read = written * a.readPerWritten;
  const usd = (written * a.model.output + read * (a.cachedShare * a.model.cacheRead + (1 - a.cachedShare) * a.model.input)) / 1e6;
  return { written, read, usd };
}

/** Does this commit's code count as AI-written under the chosen scope? */
export function counts(c: CommitPoint, a: Assumptions): boolean {
  if (c.bot) return false;
  return a.scope === "all" || Boolean(c.ai);
}

export function commitUsage(c: CommitPoint, a: Assumptions): Usage {
  return counts(c, a) ? usageOfChars(c.chars?.added ?? 0, a) : { written: 0, read: 0, usd: 0 };
}

/** Code written by AI and deleted again within a few commits: spend with nothing to show for it. */
export function wastedUsage(c: CommitPoint, a: Assumptions): Usage {
  return counts(c, a) ? usageOfChars(c.shortLivedChars ?? 0, a) : { written: 0, read: 0, usd: 0 };
}

export interface Group {
  key: string;
  commits: number;
  linesAdded: number;
  usage: Usage;
  aiCommits: number;
}

function add(u: Usage, v: Usage): Usage {
  return { written: u.written + v.written, read: u.read + v.read, usd: u.usd + v.usd };
}
const ZERO: Usage = { written: 0, read: 0, usd: 0 };

function groupBy(commits: CommitPoint[], a: Assumptions, key: (c: CommitPoint) => string | undefined): Group[] {
  const m = new Map<string, Group>();
  for (const c of commits) {
    const k = key(c);
    if (k === undefined) continue;
    const g = m.get(k) ?? { key: k, commits: 0, linesAdded: 0, usage: ZERO, aiCommits: 0 };
    g.commits++;
    g.linesAdded += c.churn.added;
    g.usage = add(g.usage, commitUsage(c, a));
    if (c.ai) g.aiCommits++;
    m.set(k, g);
  }
  return [...m.values()].sort((x, y) => y.usage.usd - x.usage.usd || y.commits - x.commits);
}

export interface SpendSummary {
  total: Usage;
  wasted: Usage;
  /** Commits whose code counts under the scope. */
  countedCommits: number;
  aiCommits: number;
  botCommits: number;
  byTool: Group[];
  byAuthor: Group[];
  /** Per commit, oldest first: tokens written (AI-marked vs other, under scope) and running cost. */
  series: Array<{ sha: string; aiWritten: number; otherWritten: number; cumulativeUsd: number }>;
}

export function summarize(commits: CommitPoint[], a: Assumptions): SpendSummary {
  // The first analyzed commit's churn is its whole prior history: it isn't counted (as in the churn chart).
  const counted = commits.slice(1);
  let running = 0;
  let total = ZERO;
  let wasted = ZERO;
  const series: SpendSummary["series"] = [];
  for (const c of counted) {
    const u = commitUsage(c, a);
    total = add(total, u);
    wasted = add(wasted, wastedUsage(c, a));
    running += u.usd;
    series.push({ sha: c.sha, aiWritten: c.ai ? u.written : 0, otherWritten: c.ai ? 0 : u.written, cumulativeUsd: running });
  }
  return {
    total,
    wasted,
    countedCommits: counted.filter((c) => counts(c, a)).length,
    aiCommits: counted.filter((c) => c.ai).length,
    botCommits: counted.filter((c) => c.bot).length,
    byTool: groupBy(counted, a, (c) => (c.bot ? undefined : c.ai?.tool ?? (a.scope === "all" ? "Not marked" : undefined))),
    byAuthor: groupBy(counted, a, (c) => (c.bot ? undefined : c.author)),
    series,
  };
}

export interface PullRequest {
  number: number;
  title: string;
  sha: string;
  author: string;
  date: string;
  ai?: string;
  added: number;
  deleted: number;
  usage: Usage;
  introduced: number;
  fixed: number;
  flowChanges: number;
}

export function pullRequests(commits: CommitPoint[], a: Assumptions): PullRequest[] {
  return commits
    .slice(1)
    .filter((c) => c.landing?.via === "pr" && c.landing.pr)
    .map((c) => ({
      number: c.landing!.pr!,
      title: c.landing!.title ?? c.subject,
      sha: c.sha,
      author: c.author,
      date: c.date,
      ...(c.ai ? { ai: c.ai.tool } : {}),
      added: c.churn.added,
      deleted: c.churn.deleted,
      usage: commitUsage(c, a),
      introduced: c.delta.newFindings.length,
      fixed: c.delta.resolvedFindings.length,
      flowChanges: c.flowChanges?.length ?? 0,
    }))
    .reverse();
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
