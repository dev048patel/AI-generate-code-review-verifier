import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  analyzeHistory,
  buildArchitecture,
  compareRuntime,
  diffArchitecture,
  diffFlows,
  diffGraphs,
  FactsCache,
  git,
  mapAtRef,
  RuntimeAggregator,
  summarizeDiff,
  type Architecture,
  type ArchitectureDiff,
  type FlowDiff,
  type GraphDiff,
  type HistoryAnalysis,
  type OtlpTraces,
  type RepoGraph,
  type RequestFlow,
  type RuntimeCoverage,
  type RuntimeSnapshot,
} from "@acrv/atlas";

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_OR_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9_./~^-]{1,200}$/; // no leading "-" (git option injection), no ".."

export interface AtlasJob {
  repo: string;
  status: "running" | "done" | "failed";
  progress: { done: number; total: number };
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface PrImpact {
  repo: string;
  prNumber: number;
  base: string;
  head: string;
  summary: string;
  diff: GraphDiff;
  /** Requests whose path through the code changed (unchanged ones left out). */
  flows: FlowDiff[];
  /** Both versions' architecture on one diagram. */
  architecture: ArchitectureDiff;
  before?: RepoGraph;
  after?: RepoGraph;
}

export interface CompareResult {
  before: RepoGraph;
  after: RepoGraph;
  diff: GraphDiff;
  flows: FlowDiff[];
  architecture: ArchitectureDiff;
  summary: string;
}

interface RepoState {
  dir: string;
  cache: FactsCache;
  job?: AtlasJob;
  analysis?: HistoryAnalysis;
  analyzedAt?: number;
  runtime: RuntimeAggregator;
  listeners: Set<(s: RuntimeSnapshot) => void>;
  lastUsed: number;
}

export interface AtlasServiceOptions {
  cacheDir: string;
  /** Clone URL for a repo; defaults to public GitHub. Tests point this at local repos. */
  remoteUrl?: (repo: string) => string;
  /** Looks up a PR's base and head commit (GitHub API). */
  pullRefs?: (repo: string, prNumber: number) => Promise<{ baseSha: string; headSha: string }>;
  maxCommits?: number;
  /** Keep at most this many repos in memory / on disk. */
  maxRepos?: number;
  resultTtlMs?: number;
}

/**
 * Repo Atlas as a service: shallow clones of public repos, history analysis
 * as a background job, commit-to-commit and PR impact comparisons, and live
 * runtime data from OpenTelemetry traces. Repos are only parsed, never run,
 * so analyzing a stranger's repo is safe.
 */
export class AtlasService {
  private repos = new Map<string, RepoState>();
  private readonly maxCommits: number;

  constructor(private readonly options: AtlasServiceOptions) {
    this.maxCommits = options.maxCommits ?? 150;
  }

  private state(repo: string): RepoState {
    if (!REPO_RE.test(repo)) throw new AtlasError(400, "repo must look like owner/name");
    let s = this.repos.get(repo);
    if (!s) {
      s = {
        dir: path.join(this.options.cacheDir, repo.replace("/", "__")),
        cache: new FactsCache(),
        runtime: new RuntimeAggregator(),
        listeners: new Set(),
        lastUsed: Date.now(),
      };
      this.repos.set(repo, s);
      this.evict();
    }
    s.lastUsed = Date.now();
    return s;
  }

  private evict(): void {
    const max = this.options.maxRepos ?? 25;
    if (this.repos.size <= max) return;
    const idle = [...this.repos.entries()]
      .filter(([, s]) => s.job?.status !== "running" && s.listeners.size === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [repo] of idle.slice(0, this.repos.size - max)) this.repos.delete(repo);
  }

  private remote(repo: string): string {
    return this.options.remoteUrl?.(repo) ?? `https://github.com/${repo}.git`;
  }

  /** Shallow, no-checkout clone (or refresh) deep enough for the history window. */
  private async sync(repo: string, s: RepoState, depth: number): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    try {
      await git(s.dir, ["rev-parse", "--git-dir"]);
      await git(s.dir, ["fetch", "--quiet", "--no-tags", `--depth=${depth}`, "origin", "HEAD"], { timeoutMs: 600_000 });
      await git(s.dir, ["update-ref", "refs/acrv/head", "FETCH_HEAD"]);
    } catch {
      await git(this.options.cacheDir, ["clone", "--quiet", "--no-checkout", "--single-branch", "--no-tags", `--depth=${depth}`, this.remote(repo), s.dir], {
        timeoutMs: 900_000,
      });
      await git(s.dir, ["update-ref", "refs/acrv/head", "HEAD"]);
    }
  }

  /** Starts (or returns the running / fresh) history analysis for a repo. */
  analyze(repo: string, maxCommits?: number): AtlasJob {
    const s = this.state(repo);
    if (s.job?.status === "running") return s.job;
    const fresh = s.analysis && s.analyzedAt && Date.now() - s.analyzedAt < (this.options.resultTtlMs ?? 15 * 60_000);
    if (fresh && s.job) return s.job;
    const commits = Math.max(2, Math.min(maxCommits ?? this.maxCommits, 500));
    const job: AtlasJob = { repo, status: "running", progress: { done: 0, total: commits }, startedAt: new Date().toISOString() };
    s.job = job;
    void (async () => {
      try {
        await this.sync(repo, s, commits + 1);
        s.analysis = await analyzeHistory(s.dir, {
          ref: "refs/acrv/head",
          maxCommits: commits,
          repo,
          onProgress: (done, total) => (job.progress = { done, total }),
        });
        s.analyzedAt = Date.now();
        job.status = "done";
      } catch (err) {
        job.status = "failed";
        job.error = /not found|Repository not found|could not read Username/i.test(String(err))
          ? "Repository not found (only public GitHub repos can be analyzed)."
          : String(err).split("\n")[0]!.slice(0, 300);
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    })();
    return job;
  }

  status(repo: string): { job?: AtlasJob; analysis?: HistoryAnalysis } {
    const s = this.state(repo);
    return { job: s.job, analysis: s.job?.status === "done" ? s.analysis : undefined };
  }

  private async mapAt(repo: string, ref: string): Promise<{ graph: RepoGraph; flows: RequestFlow[] }> {
    if (!SHA_OR_REF_RE.test(ref)) throw new AtlasError(400, "invalid ref");
    const s = this.requireAnalyzed(repo);
    return mapAtRef(s.dir, ref === "HEAD" ? "refs/acrv/head" : ref, s.cache);
  }

  async graph(repo: string, ref: string): Promise<RepoGraph> {
    return (await this.mapAt(repo, ref)).graph;
  }

  /** Every request, step by step, at a commit. */
  async flows(repo: string, ref: string): Promise<RequestFlow[]> {
    return (await this.mapAt(repo, ref)).flows;
  }

  /** The app as an architecture diagram: parts, connections and one story per request. */
  async architecture(repo: string, ref: string): Promise<Architecture> {
    return buildArchitecture((await this.mapAt(repo, ref)).flows);
  }

  async compare(repo: string, from: string, to: string): Promise<CompareResult> {
    const before = await this.mapAt(repo, from);
    const after = await this.mapAt(repo, to);
    const diff = diffGraphs(before.graph, after.graph);
    return {
      before: before.graph,
      after: after.graph,
      diff,
      flows: changedFlows(before.flows, after.flows),
      architecture: diffArchitecture(buildArchitecture(before.flows), buildArchitecture(after.flows)),
      summary: summarizeDiff(diff),
    };
  }

  /** What a pull request does to the map: base (merge base) vs. PR head. */
  async prImpact(repo: string, prNumber: number, includeGraphs = false): Promise<PrImpact> {
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new AtlasError(400, "invalid PR number");
    if (!this.options.pullRefs) throw new AtlasError(501, "PR lookups are not configured");
    const s = this.state(repo);
    const { baseSha, headSha } = await this.options.pullRefs(repo, prNumber);
    try {
      await git(s.dir, ["rev-parse", "--git-dir"]);
    } catch {
      await this.sync(repo, s, 50);
    }
    // PR heads from forks are reachable through the base repo's pull/N/head ref.
    await git(s.dir, ["fetch", "--quiet", "--no-tags", "--depth=200", "origin", baseSha, `pull/${prNumber}/head`], { timeoutMs: 600_000 }).catch(
      () => git(s.dir, ["fetch", "--quiet", "--no-tags", "--depth=200", "origin", baseSha, headSha], { timeoutMs: 600_000 }),
    );
    let base = baseSha;
    try {
      base = (await git(s.dir, ["merge-base", baseSha, headSha])).trim();
    } catch {
      /* shallow history: compare against the base tip */
    }
    const before = await mapAtRef(s.dir, base, s.cache);
    const after = await mapAtRef(s.dir, headSha, s.cache);
    const diff = diffGraphs(before.graph, after.graph);
    return {
      repo,
      prNumber,
      base,
      head: headSha,
      summary: summarizeDiff(diff),
      diff,
      flows: changedFlows(before.flows, after.flows),
      architecture: diffArchitecture(buildArchitecture(before.flows), buildArchitecture(after.flows)),
      ...(includeGraphs ? { before: before.graph, after: after.graph } : {}),
    };
  }

  ingestTraces(repo: string, payload: OtlpTraces): number {
    const s = this.state(repo);
    const n = s.runtime.ingest(payload);
    if (n > 0 && s.listeners.size > 0) {
      const snap = s.runtime.snapshot();
      for (const l of s.listeners) l(snap);
    }
    return n;
  }

  runtime(repo: string): { snapshot: RuntimeSnapshot; coverage?: RuntimeCoverage } {
    const s = this.state(repo);
    const snapshot = s.runtime.snapshot();
    return { snapshot, coverage: s.analysis ? compareRuntime(s.analysis.head, snapshot) : undefined };
  }

  subscribe(repo: string, listener: (s: RuntimeSnapshot) => void): () => void {
    const s = this.state(repo);
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

  private requireAnalyzed(repo: string): RepoState {
    const s = this.state(repo);
    if (!s.analysis) throw new AtlasError(409, "Analyze the repo first");
    return s;
  }
}

function changedFlows(before: RequestFlow[], after: RequestFlow[]): FlowDiff[] {
  return diffFlows(before, after).filter((d) => d.status !== "same");
}

export class AtlasError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
