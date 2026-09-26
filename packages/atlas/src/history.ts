import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { buildArchitecture, diffArchitecture, type Architecture } from "./architecture.js";
import { detectAi, detectBot, landing } from "./authorship.js";
import { diffGraphs } from "./diff.js";
import { extractFacts, isCodeFile, isTestFile } from "./extract.js";
import { BlobReader, changedFiles, commitPatches, git, listCommits, listTree, MAX_FILE_BYTES, mergedCommits } from "./git.js";
import { buildFlows, diffFlows } from "./flow.js";
import { buildGraph } from "./graph.js";
import type { CommitPoint, FileFacts, HistoryAnalysis, Hotspot, Recommendation, RepoGraph, RequestFlow } from "./types.js";

export const MAX_FILES = 5000;

/** Parsed facts per blob id: a file version is parsed once, however many commits contain it. */
export class FactsCache {
  private byBlob = new Map<string, FileFacts>();

  async get(reader: BlobReader, file: string, blob: string): Promise<FileFacts | undefined> {
    const key = `${blob}:${file}`; // facts include the path (Next.js routes, tests), so key on both
    const hit = this.byBlob.get(key);
    if (hit) return hit;
    const content = await reader.read(blob);
    if (content === null) return undefined;
    const facts = safeExtract(file, content);
    this.byBlob.set(key, facts);
    return facts;
  }

  get size(): number {
    return this.byBlob.size;
  }
}

function safeExtract(file: string, content: string): FileFacts {
  try {
    return extractFacts(file, content);
  } catch {
    return { path: file, loc: 0, imports: [], exports: [], exportsStar: false, routes: [], middlewareUses: [], functions: 0, isTest: false };
  }
}

/**
 * Files package.json points at -- main/module/bin/exports, plus any path in
 * scripts or tool config (e.g. `"seed": "ts-node src/prisma/seed.ts"`) -- are
 * entry points, not dead code.
 */
export function entryFilesFromPackageJson(raw: string): string[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/(?:^|[\s"'=])(\.?\/?[\w@./-]+\.(?:[cm]?[jt]sx?))(?=$|[\s"'])/g)) {
        out.add(path.posix.normalize(m[1]!.replace(/^\.\//, "")));
      }
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(pkg);
  return [...out];
}

async function entryFiles(repoDir: string, ref: string | undefined): Promise<string[]> {
  try {
    const raw = ref ? await git(repoDir, ["show", `${ref}:package.json`]) : await readFile(path.join(repoDir, "package.json"), "utf-8");
    return entryFilesFromPackageJson(raw);
  } catch {
    return [];
  }
}

/** Parsed facts for every code file at a commit (or branch / tag). */
export async function factsAtRef(repoDir: string, ref: string, cache = new FactsCache()): Promise<{ sha: string; facts: FileFacts[] }> {
  const sha = (await git(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  const { entries } = await listTree(repoDir, sha);
  const reader = new BlobReader(repoDir);
  try {
    const facts = await Promise.all(entries.slice(0, MAX_FILES).map((e) => cache.get(reader, e.path, e.blob)));
    return { sha, facts: facts.filter((f): f is FileFacts => Boolean(f)) };
  } finally {
    reader.close();
  }
}

/** The map at any commit (or branch / tag). */
export async function graphAtRef(repoDir: string, ref: string, cache = new FactsCache()): Promise<RepoGraph> {
  const { sha, facts } = await factsAtRef(repoDir, ref, cache);
  return buildGraph(facts, { commit: sha, entryFiles: await entryFiles(repoDir, sha) });
}

/** The map and every request flow at a commit, from one parse. */
export async function mapAtRef(repoDir: string, ref: string, cache = new FactsCache()): Promise<{ graph: RepoGraph; flows: RequestFlow[] }> {
  const { sha, facts } = await factsAtRef(repoDir, ref, cache);
  return { graph: buildGraph(facts, { commit: sha, entryFiles: await entryFiles(repoDir, sha) }), flows: buildFlows(facts) };
}

/**
 * Facts for the working tree as it is on disk right now -- committed or not.
 * Symlinks are skipped so a link can't pull files from outside the repo in.
 */
export async function factsOfWorktree(repoDir: string): Promise<FileFacts[]> {
  const listed = await git(repoDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files = [...new Set(listed.split("\0").filter((f) => f && isCodeFile(f)))].slice(0, MAX_FILES);
  const facts: FileFacts[] = [];
  for (const file of files) {
    const abs = path.join(repoDir, file);
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      facts.push(safeExtract(file, await readFile(abs, "utf-8")));
    } catch {
      // deleted in the working tree
    }
  }
  return facts;
}

/** The map of the working tree: the "before I open a PR" view. Diff it against the base branch. */
export async function graphOfWorktree(repoDir: string): Promise<RepoGraph> {
  return buildGraph(await factsOfWorktree(repoDir), { commit: "WORKTREE", entryFiles: await entryFiles(repoDir, undefined) });
}

export interface AnalyzeHistoryOptions {
  ref?: string;
  maxCommits?: number;
  /** A deleted line counts as thrown away if it was added within this many commits. */
  shortLivedWindow?: number;
  repo?: string;
  onProgress?: (done: number, total: number) => void;
}

const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;
/** Output of tools, not code someone (or some AI) wrote: kept out of token estimates. */
export const GENERATED_PATH = /(^|\/)(dist|build|out|vendor|generated|coverage|\.next|\.nuxt|node_modules|public\/assets)\/|\.min\.[cm]?js$|\.bundle\.[cm]?js$|[.-]generated\.[cm]?[jt]sx?$|(^|\/)(package-lock|yarn\.lock|pnpm-lock)/;
/** Minified or embedded-data lines. */
const MACHINE_LINE_CHARS = 400;

/**
 * Replays the newest `maxCommits` first-parent commits and records how the
 * map evolved: structure metrics per commit, what each commit added / broke /
 * fixed, churn, code that was thrown away soon after being written, hotspots,
 * and recommendations.
 */
export async function analyzeHistory(repoDir: string, options: AnalyzeHistoryOptions = {}): Promise<HistoryAnalysis> {
  const ref = options.ref ?? "HEAD";
  const maxCommits = options.maxCommits ?? 150;
  const window = options.shortLivedWindow ?? 5;
  const commits = await listCommits(repoDir, ref, maxCommits);
  if (commits.length === 0) throw new Error(`No commits found at ${ref}`);
  const patches = await commitPatches(repoDir, ref, maxCommits);

  const cache = new FactsCache();
  const reader = new BlobReader(repoDir);
  const entries = await entryFiles(repoDir, ref);
  const tree = new Map<string, string>(); // path -> blob
  const points: CommitPoint[] = [];
  let truncated = false;
  let previous: RepoGraph | undefined;
  let head: RepoGraph | undefined;
  let previousFlows: RequestFlow[] | undefined;
  let previousArch: Architecture | undefined;

  // Line provenance for "thrown away" detection: file -> line text -> commit indexes that added it.
  const provenance = new Map<string, Map<string, number[]>>();
  const fileStats = new Map<string, { commits: number; churn: number }>();
  let totalAdded = 0;
  let totalShortLived = 0;
  let totalShortLivedChars = 0;

  try {
    for (const [i, c] of commits.entries()) {
      if (i === 0) {
        const { entries } = await listTree(repoDir, c.sha);
        if (entries.length > MAX_FILES) truncated = true;
        for (const e of entries.slice(0, MAX_FILES)) tree.set(e.path, e.blob);
      } else {
        for (const ch of await changedFiles(repoDir, commits[i - 1]!.sha, c.sha)) {
          if (ch.blob) {
            if (tree.size < MAX_FILES || tree.has(ch.path)) tree.set(ch.path, ch.blob);
            else truncated = true;
          } else tree.delete(ch.path);
        }
      }

      const facts = await Promise.all([...tree.entries()].map(([p, b]) => cache.get(reader, p, b)));
      const present = facts.filter((f): f is FileFacts => Boolean(f));
      const flows = buildFlows(present);
      const graph = buildGraph(present, { commit: c.sha, entryFiles: entries, flows });
      const arch = buildArchitecture(flows);

      // Churn and short-lived lines (the first commit's patch is its whole pre-window history: skip it).
      let added = 0;
      let deleted = 0;
      let shortLived = 0;
      let shortLivedChars = 0;
      let addedChars = 0;
      let deletedChars = 0;
      const patch = i > 0 ? patches.get(c.sha) : undefined;
      for (const f of patch?.files ?? []) {
        added += f.added.length;
        deleted += f.deleted.length;
        if (!GENERATED_PATH.test(f.path)) {
          for (const l of f.added) if (l.length <= MACHINE_LINE_CHARS) addedChars += l.length + 1;
          for (const l of f.deleted) if (l.length <= MACHINE_LINE_CHARS) deletedChars += l.length + 1;
        }
        const s = fileStats.get(f.path) ?? { commits: 0, churn: 0 };
        s.commits++;
        s.churn += f.added.length + f.deleted.length;
        fileStats.set(f.path, s);
        const lines = provenance.get(f.path) ?? new Map<string, number[]>();
        provenance.set(f.path, lines);
        for (const raw of f.deleted) {
          const text = raw.trim();
          if (TRIVIAL_LINE.test(text) || text.length < 4) continue;
          const stack = lines.get(text);
          const addedAt = stack?.pop();
          if (addedAt !== undefined && i - addedAt <= window) {
            shortLived++;
            shortLivedChars += text.length;
          }
        }
        for (const raw of f.added) {
          const text = raw.trim();
          if (TRIVIAL_LINE.test(text) || text.length < 4) continue;
          const stack = lines.get(text) ?? [];
          stack.push(i);
          lines.set(text, stack);
        }
      }
      if (i > 0) {
        totalAdded += added;
        totalShortLived += shortLived;
        totalShortLivedChars += shortLivedChars;
      }

      const d = previous ? diffGraphs(previous, graph) : undefined;
      let ai = detectAi(c);
      if (!ai && c.parents >= 2) {
        // A merge commit's own message rarely says who wrote the code: read the trailers of the commits it merged.
        const merged = await mergedCommits(repoDir, c.sha);
        const marks = merged.map((m) => detectAi(m)).filter((m): m is NonNullable<typeof m> => Boolean(m));
        if (marks.length) ai = { tool: marks[0]!.tool, evidence: `${marks.length} of ${merged.length} commits in this merge: ${marks[0]!.evidence}`.slice(0, 160) };
      }
      const bot = ai ? undefined : detectBot(c);
      const flowChanges = previousFlows
        ? diffFlows(previousFlows, flows)
            .filter((x) => x.status !== "same")
            .slice(0, 12)
            .map((x) => ({ label: x.label, status: x.status, summary: x.summary }))
        : [];
      points.push({
        sha: c.sha,
        author: c.author,
        email: c.email,
        date: c.date,
        subject: c.subject,
        ...(ai ? { ai } : {}),
        ...(bot ? { bot } : {}),
        landing: landing(c),
        chars: { added: i > 0 ? addedChars : 0, deleted: i > 0 ? deletedChars : 0 },
        flowChanges,
        architecture: previousArch ? diffArchitecture(previousArch, arch).summary.slice(0, 12) : [],
        metrics: graph.metrics,
        churn: { added, deleted, files: patch?.files.length ?? 0 },
        shortLivedLines: shortLived,
        shortLivedChars,
        delta: {
          modulesAdded: d ? d.addedNodes.filter((n) => n.kind === "module").length : 0,
          modulesRemoved: d ? d.removedNodes.filter((n) => n.kind === "module").length : 0,
          edgesAdded: d?.addedEdges.length ?? 0,
          edgesRemoved: d?.removedEdges.length ?? 0,
          newFindings: d ? d.newFindings.map((f) => f.id) : [],
          resolvedFindings: d ? d.resolvedFindings.map((f) => f.id) : [],
          introduced: d ? d.newFindings.slice(0, 12) : [],
        },
      });
      previous = graph;
      previousFlows = flows;
      previousArch = arch;
      head = graph;
      options.onProgress?.(i + 1, commits.length);
    }
  } finally {
    reader.close();
  }

  const headGraph = head!;
  const locByFile = new Map(headGraph.nodes.filter((n) => n.kind === "module").map((n) => [n.file!, n.loc ?? 0]));
  const hotspots: Hotspot[] = [...fileStats.entries()]
    .filter(([f]) => locByFile.has(f) && !isTestFile(f))
    .map(([file, s]) => ({ file, commits: s.commits, churn: s.churn, loc: locByFile.get(file) ?? 0 }))
    .sort((a, b) => b.commits * Math.log2(2 + b.churn) - a.commits * Math.log2(2 + a.churn))
    .slice(0, 10);

  const analysis: HistoryAnalysis = {
    repo: options.repo,
    ref,
    commits: points,
    head: headGraph,
    hotspots,
    waste: {
      shortLivedLines: totalShortLived,
      addedLines: totalAdded,
      estimatedTokens: Math.round(totalShortLivedChars / 4),
      windowCommits: window,
    },
    recommendations: [],
    analyzedFiles: cache.size,
    truncated,
  };
  analysis.recommendations = recommend(analysis);
  return analysis;
}

/** Turns the analysis into a short, prioritized to-do list. */
export function recommend(a: HistoryAnalysis): Recommendation[] {
  const recs: Recommendation[] = [];
  const introducedAt = (findingId: string) => [...a.commits].reverse().find((c) => c.delta.newFindings.includes(findingId));

  for (const f of a.head.findings.filter((x) => x.kind === "auth-route-no-rate-limit")) {
    const when = introducedAt(f.id);
    recs.push({
      id: `rec:${f.id}`,
      priority: "high",
      title: `Add rate limiting to ${f.title.replace(/ has no rate limiting$/, "")}`,
      detail:
        `${f.detail} For Express: \`const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10 })\`, then \`router.post(path, loginLimiter, handler)\`.` +
        (when ? ` The gap appeared in ${when.sha.slice(0, 7)} ("${when.subject}").` : ""),
      files: f.file ? [f.file] : undefined,
      commit: when?.sha,
    });
  }

  const broken = a.head.findings.filter((x) => x.kind === "broken-import" || x.kind === "broken-reference");
  if (broken.length > 0) {
    const when = introducedAt(broken[0]!.id);
    recs.push({
      id: "rec:broken",
      priority: "high",
      title: `Fix ${broken.length} broken import(s)`,
      detail: `${broken[0]!.title}${broken.length > 1 ? ` and ${broken.length - 1} more` : ""}. These fail at build or run time.` +
        (when ? ` First broken in ${when.sha.slice(0, 7)} ("${when.subject}").` : ""),
      files: [...new Set(broken.map((b) => b.file!).filter(Boolean))].slice(0, 10),
      commit: when?.sha,
    });
  }

  const cycles = a.head.findings.filter((x) => x.kind === "import-cycle");
  if (cycles.length > 0) {
    recs.push({
      id: "rec:cycles",
      priority: "medium",
      title: `Break ${cycles.length} import cycle(s)`,
      detail: `${cycles[0]!.detail} Move the shared piece into its own module that both sides import.`,
      files: cycles.map((c) => c.file!).filter(Boolean),
    });
  }

  const { shortLivedLines, addedLines, estimatedTokens, windowCommits } = a.waste;
  if (addedLines >= 200 && shortLivedLines / addedLines >= 0.15) {
    recs.push({
      id: "rec:waste",
      priority: "medium",
      title: `${Math.round((shortLivedLines / addedLines) * 100)}% of new code was thrown away within ${windowCommits} commits`,
      detail:
        `${shortLivedLines} of ${addedLines} added lines were deleted again soon after (~${estimatedTokens.toLocaleString()} tokens of generated code). ` +
        "That's the signature of generate-then-rewrite loops: agree on the interface and tests first, then generate the implementation.",
    });
  }

  const hot = a.hotspots.filter((h) => h.commits >= 5 && h.loc >= 200).slice(0, 3);
  if (hot.length > 0) {
    recs.push({
      id: "rec:hotspots",
      priority: "medium",
      title: `Split or add tests to ${hot.length} hotspot file(s)`,
      detail: `${hot.map((h) => `${h.file} (${h.commits} commits, ${h.loc} lines)`).join(", ")} change most often and are large, which is where regressions come from.`,
      files: hot.map((h) => h.file),
    });
  }

  if (a.head.findings.some((f) => f.kind === "no-tests")) {
    recs.push({ id: "rec:tests", priority: "medium", title: "Add a test suite", detail: a.head.findings.find((f) => f.kind === "no-tests")!.detail });
  }

  const unused = a.head.findings.filter((f) => f.kind === "unused-module");
  if (unused.length > 0) {
    recs.push({
      id: "rec:unused",
      priority: "low",
      title: `Review ${unused.length} module(s) nothing imports`,
      detail: "Either dead code (delete it to shrink what everyone has to read) or new code that isn't wired in yet.",
      files: unused.slice(0, 10).map((u) => u.file!),
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((x, y) => order[x.priority] - order[y.priority]);
}
