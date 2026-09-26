import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { Architecture, AtlasJob, CommitPoint, CompareResult, HistoryAnalysis, RepoProblem, RepoReport } from "../atlasTypes";
import { ArchDiagram } from "../components/atlas/ArchDiagram";
import { ChurnChart, MetricTrend } from "../components/atlas/Charts";
import { FlowChanges } from "../components/atlas/RequestFlow";
import { CommitExplorer } from "../components/report/CommitExplorer";
import { PromptBox } from "../components/report/PromptBox";
import { CumulativeCost, RankedBars, TokensPerCommit } from "../components/report/SpendCharts";
import { parseRepoInput } from "../report/parseInput";
import {
  DEFAULT_ASSUMPTIONS,
  formatTokens,
  formatUsd,
  MODEL_PRICES,
  pullRequests,
  summarize,
  type Assumptions,
} from "../report/usage";

const EXAMPLES = ["gothinkster/node-express-realworld-example-app", "expressjs/express", "vercel/next.js/pull/1"];

/** One box: paste any GitHub link. */
export function ReportLanding() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const go = (raw: string) => {
    const t = parseRepoInput(raw);
    if (!t) {
      setError("Paste a GitHub link (repo, pull request or commit) or owner/name.");
      return;
    }
    const q = new URLSearchParams();
    if (t.pr) q.set("pr", String(t.pr));
    if (t.sha) q.set("sha", t.sha);
    navigate(`/r/${t.repo}${q.toString() ? `?${q}` : ""}`);
  };
  return (
    <div className="report-landing">
      <h1>Everything about a repository, from one link</h1>
      <p className="muted">
        How it's built, how every commit, push and pull request changed it, what AI wrote and roughly what that cost, what's broken or
        missing, and a ready-to-paste prompt to fix each problem.
      </p>
      <form
        className="landing-form"
        onSubmit={(e) => {
          e.preventDefault();
          go(value);
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://github.com/owner/repo   ·   …/pull/42   ·   owner/repo"
          aria-label="GitHub link"
          autoFocus
        />
        <button type="submit">Analyze</button>
      </form>
      {error && <p className="error-text">{error}</p>}
      <p className="muted small">
        Try:{" "}
        {EXAMPLES.map((e, i) => (
          <span key={e}>
            {i > 0 && " · "}
            <button className="link-button" onClick={() => go(e)}>
              {e}
            </button>
          </span>
        ))}
      </p>
      <p className="muted small">Public GitHub repos. The code is read, never run.</p>
    </div>
  );
}

function loadAssumptions(): Assumptions {
  try {
    const raw = localStorage.getItem("acrv:assumptions");
    if (!raw) return DEFAULT_ASSUMPTIONS;
    const v = JSON.parse(raw) as Partial<Assumptions> & { modelId?: string };
    return {
      ...DEFAULT_ASSUMPTIONS,
      ...v,
      model: MODEL_PRICES.find((m) => m.id === v.modelId) ?? DEFAULT_ASSUMPTIONS.model,
    };
  } catch {
    return DEFAULT_ASSUMPTIONS;
  }
}

function saveAssumptions(a: Assumptions): void {
  try {
    localStorage.setItem("acrv:assumptions", JSON.stringify({ ...a, model: undefined, modelId: a.model.id }));
  } catch {
    /* private mode: keep it for this visit only */
  }
}

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "pr", label: "This pull request" },
  { id: "spend", label: "AI & spend" },
  { id: "evolution", label: "Evolution" },
  { id: "commits", label: "Commits" },
  { id: "prs", label: "PRs & pushes" },
  { id: "architecture", label: "Architecture" },
  { id: "problems", label: "Problems & fixes" },
  { id: "people", label: "People" },
  { id: "hotspots", label: "Hotspots" },
] as const;

/** /r/:owner/:repo — the whole report for one repository. */
export function Report() {
  const { owner = "", name = "" } = useParams();
  const repo = `${owner}/${name}`;
  const [params, setParams] = useSearchParams();
  const prNumber = Number(params.get("pr")) || undefined;
  const depth = Number(params.get("n")) || 150;
  const [job, setJob] = useState<AtlasJob | null>(null);
  const [analysis, setAnalysis] = useState<HistoryAnalysis | null>(null);
  const [report, setReport] = useState<RepoReport | null>(null);
  const [arch, setArch] = useState<Architecture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assumptions, setAssumptionsState] = useState<Assumptions>(loadAssumptions);
  const [selected, setSelected] = useState<string | null>(params.get("sha"));
  const [active, setActive] = useState<string>("overview");

  const setAssumptions = (a: Assumptions) => {
    setAssumptionsState(a);
    saveAssumptions(a);
  };

  // Reuse an existing analysis if the server has one (opening a shared link costs nothing);
  // start one only when there isn't one yet, or when the history depth was changed here.
  const [rerun, setRerun] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setReport(null);
    setArch(null);
    setError(null);
    const load = async (a: HistoryAnalysis) => {
      setAnalysis(a);
      const [r, ar] = await Promise.all([api.atlasReport(repo), api.atlasArchitecture(repo)]);
      if (!cancelled) {
        setReport(r);
        setArch(ar);
      }
    };
    const poll = async () => {
      try {
        const s = await api.atlasStatus(repo);
        if (cancelled) return;
        if (s.job) setJob(s.job);
        if (s.job?.status === "failed") return setError(s.job.error ?? "Analysis failed");
        if (s.analysis) return await load(s.analysis);
        setTimeout(() => void poll(), 1000);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    const start = () =>
      api
        .atlasAnalyze(repo, depth)
        .then(({ job: j }) => {
          if (cancelled) return;
          setJob(j);
          void poll();
        })
        .catch((e) => !cancelled && setError(String(e)));
    if (rerun > 0) void start();
    else
      api
        .atlasStatus(repo)
        .then((s) => {
          if (cancelled) return;
          if (s.analysis) void load(s.analysis).catch((e) => !cancelled && setError(String(e)));
          else if (s.job?.status === "running") {
            setJob(s.job);
            void poll();
          } else void start();
        })
        .catch(() => !cancelled && void start());
    return () => {
      cancelled = true;
    };
  }, [repo, rerun]); // depth is read when a run starts; changing it bumps rerun

  // Scroll-spy for the section rail.
  useEffect(() => {
    if (!analysis || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    document.querySelectorAll(".report-section").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [analysis, report]);

  // Links into the report (#problems, ?sha=…) point at sections that only exist once it has loaded:
  // scroll there after the report renders, once.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!analysis || !report || scrolled.current) return;
    scrolled.current = true;
    const target = params.get("sha") ? "commits" : window.location.hash.replace(/^#/, "");
    if (!target) return;
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView?.({ block: "start" }));
  }, [analysis, report]);

  const spend = useMemo(() => (analysis ? summarize(analysis.commits, assumptions) : null), [analysis, assumptions]);
  const prs = useMemo(() => (analysis ? pullRequests(analysis.commits, assumptions) : []), [analysis, assumptions]);

  if (error) {
    return (
      <div className="report-status card">
        <h2 className="card-title">{repo}</h2>
        <p className="error-text">{error}</p>
        <Link to="/r">Try another repository</Link>
      </div>
    );
  }
  if (!analysis || !spend) {
    const p = job?.progress;
    const pct = p ? Math.round((p.done / Math.max(1, p.total)) * 100) : 0;
    return (
      <div className="report-status card" aria-live="polite">
        <h2 className="card-title">{repo}</h2>
        <ol className="status-steps">
          <li className={!p || p.done === 0 ? "now" : "done"}>Cloning the repository (history only, nothing is run)</li>
          <li className={p && p.done > 0 && p.done < p.total ? "now" : p && p.done >= p.total ? "done" : ""}>
            Replaying commits{p && p.done > 0 ? ` · ${p.done} of ${p.total}` : ""}
          </li>
          <li className={p && p.done >= p.total ? "now" : ""}>Building the report</li>
        </ol>
        <div className="scan-bar-track">
          <div className="scan-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  const commits = analysis.commits;
  const first = commits[0]!;
  const last = commits[commits.length - 1]!;
  const counted = commits.slice(1);
  const pushes = counted.filter((c) => c.landing?.via === "push").length;
  const problems = report?.problems ?? [];
  const bySeverity = (s: RepoProblem["severity"]) => problems.filter((p) => p.severity === s).length;
  const tools = [...new Set(counted.flatMap((c) => (c.ai ? [c.ai.tool] : [])))];
  const routes = analysis.head.metrics.routes;
  const gapRoutes = arch?.stories.filter((s) => s.severity).length ?? 0;
  const pick = (sha: string) => {
    setSelected(sha);
    document.getElementById("commits")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const sections = SECTIONS.filter((s) => s.id !== "pr" || prNumber);

  return (
    <div className="report">
      <nav className="report-rail" aria-label="Report sections">
        <div className="rail-repo">
          <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
            {repo}
          </a>
        </div>
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className={active === s.id ? "on" : ""} onClick={() => setActive(s.id)}>
            {s.label}
            {s.id === "problems" && problems.length > 0 && <span className={`rail-n${bySeverity("high") + bySeverity("critical") ? " bad" : ""}`}>{problems.length}</span>}
            {s.id === "commits" && <span className="rail-n">{commits.length}</span>}
            {s.id === "prs" && prs.length > 0 && <span className="rail-n">{prs.length}</span>}
          </a>
        ))}
        <div className="rail-foot">
          <Link to={`/atlas?repo=${encodeURIComponent(repo)}`}>Open in explorer →</Link>
        </div>
      </nav>

      <main className="report-main">
        <header className="report-head">
          <div>
            <h1>
              <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
                {repo}
              </a>
            </h1>
            <div className="muted">
              {commits.length} commits analyzed · {first.date.slice(0, 10)} → {last.date.slice(0, 10)} · newest {last.sha.slice(0, 7)}
              {analysis.truncated ? " · large repo: first 5,000 files" : ""}
            </div>
          </div>
          <div className="report-actions">
            <label className="field-label" htmlFor="depth">
              History
            </label>
            <select
              id="depth"
              value={depth}
              onChange={(e) => {
                const q = new URLSearchParams(params);
                q.set("n", e.target.value);
                setParams(q);
                setRerun((n) => n + 1);
              }}
            >
              {[50, 150, 300, 500].map((n) => (
                <option key={n} value={n}>
                  last {n} commits
                </option>
              ))}
            </select>
            <button className="secondary" onClick={() => setRerun((n) => n + 1)} title="Fetch new commits and analyze again">
              Refresh
            </button>
            <button className="secondary" onClick={() => void navigator.clipboard?.writeText(window.location.href)}>
              Copy link
            </button>
          </div>
        </header>

        <Section id="overview" title="Overview">
          <p className="headline">{headline(repo, analysis, spend.aiCommits, tools, problems, assumptions, spend.total.usd)}</p>
          <div className="kpis">
            <Kpi label="Commits" value={String(counted.length)} note={`${prs.length} via pull requests · ${pushes} pushed directly`} />
            <Kpi label="Marked as AI-written" value={`${counted.length ? Math.round((spend.aiCommits / counted.length) * 100) : 0}%`} note={tools.length ? tools.join(" · ") : "no AI markers found in commit messages"} />
            <Kpi label="Est. AI tokens" value={formatTokens(spend.total.written + spend.total.read)} note={`${formatTokens(spend.total.written)} written · ${formatTokens(spend.total.read)} read`} />
            <Kpi label="Est. AI cost" value={formatUsd(spend.total.usd)} note={`${assumptions.model.label} · ${assumptions.scope === "marked" ? "AI-marked commits" : "all commits"}`} />
            <Kpi label="Spent on thrown-away code" value={formatUsd(spend.wasted.usd)} note={`${analysis.waste.shortLivedLines} lines deleted within ${analysis.waste.windowCommits} commits`} tone={spend.wasted.usd > 0 ? "warn" : undefined} />
            <Kpi label="Open problems" value={String(problems.length)} note={`${bySeverity("critical") + bySeverity("high")} high · ${bySeverity("medium")} medium · ${bySeverity("low")} low`} tone={bySeverity("high") + bySeverity("critical") ? "bad" : undefined} />
            <Kpi label="HTTP requests" value={String(routes)} note={gapRoutes ? `${gapRoutes} with a missing safeguard` : "no missing safeguards"} tone={gapRoutes ? "warn" : undefined} />
            <Kpi label="Code" value={`${analysis.head.metrics.modules} modules`} note={`${analysis.head.metrics.loc.toLocaleString()} lines · ${analysis.head.metrics.testModules} test files`} />
          </div>
        </Section>

        {prNumber && (
          <Section id="pr" title={`Pull request #${prNumber}: what it changes`}>
            <PullRequestPreview repo={repo} number={prNumber} />
          </Section>
        )}

        <Section id="spend" title="AI & spend" subtitle="Estimated from the code each commit added. Git records no tokens, so the assumptions are shown and adjustable.">
          <AssumptionsPanel value={assumptions} onChange={setAssumptions} />
          {spend.total.written > 0 ? (
            <>
              <TokensPerCommit summary={spend} commits={commits} onPick={pick} />
              <CumulativeCost summary={spend} commits={commits} />
              {assumptions.scope === "marked" && spend.aiCommits < counted.length * 0.25 && (
                <p className="muted small">
                  Only {spend.aiCommits} of {counted.length} commits carry an AI marker. Unmarked commits may still be AI-assisted.{" "}
                  <button className="link-button" onClick={() => setAssumptions({ ...assumptions, scope: "all" })}>
                    Count every commit (upper bound)
                  </button>
                </p>
              )}
            </>
          ) : (
            <div className="empty-state">
              <p>
                No commit in this window carries an AI marker (a <code>Co-Authored-By:</code> trailer, a “Generated with …” footer or an AI agent as author),
                so there's no AI spend to estimate. Many AI-assisted commits aren't marked, though.
              </p>
              <button onClick={() => setAssumptions({ ...assumptions, scope: "all" })}>Estimate as if every commit were AI-written (upper bound)</button>
            </div>
          )}
          <div className="grid-auto">
            <RankedBars title="Estimated cost by AI tool" groups={spend.byTool} value={(g) => g.usage.usd} format={formatUsd} empty="No commits are marked as AI-written. Switch the scope to “all commits” to see what an AI assistant would have cost." />
            <RankedBars title="Estimated cost by author" groups={spend.byAuthor.filter((g) => g.usage.usd > 0)} value={(g) => g.usage.usd} format={formatUsd} empty="Nothing counted under the current scope." />
            <RankedBars title="Lines added by author" groups={spend.byAuthor} value={(g) => g.linesAdded} format={(n) => n.toLocaleString()} empty="No commits." />
          </div>
        </Section>

        <Section id="evolution" title="Evolution" subtitle="The shape of the code after every commit. Click a point to open that commit.">
          <div className="grid-auto trends">
            <MetricTrend title="Modules" commits={commits} value={(c) => c.metrics.modules} onPick={(c) => pick(c.sha)} />
            <MetricTrend title="HTTP routes" commits={commits} value={(c) => c.metrics.routes} onPick={(c) => pick(c.sha)} />
            <MetricTrend title="Lines of code" commits={commits} value={(c) => c.metrics.loc} onPick={(c) => pick(c.sha)} />
            <MetricTrend title="Open structural problems" commits={commits} value={(c) => c.metrics.unprotectedAuthRoutes + c.metrics.brokenImports + c.metrics.cycles} onPick={(c) => pick(c.sha)} />
            <MetricTrend title="Test files" commits={commits} value={(c) => c.metrics.testModules} onPick={(c) => pick(c.sha)} />
            <MetricTrend title="Dependencies" commits={commits} value={(c) => c.metrics.packages} onPick={(c) => pick(c.sha)} />
          </div>
          <ChurnChart commits={commits} onPick={(c: CommitPoint) => pick(c.sha)} />
        </Section>

        <Section id="commits" title="Commits" subtitle="Every commit's story: who wrote it and with what, what it cost, what it did to requests and the architecture, and what it broke.">
          <CommitExplorer repo={repo} commits={commits} assumptions={assumptions} fixes={report?.commits ?? []} problems={problems} selected={selected} onSelect={setSelected} />
        </Section>

        <Section id="prs" title="Pull requests & pushes" subtitle="Detected from merge and squash commit messages on the main branch; anything else was pushed straight to it.">
          {prs.length === 0 ? (
            <p className="muted">No merged pull requests in this window: every commit was pushed directly.</p>
          ) : (
            <div className="table-wrap">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>PR</th>
                    <th>Title</th>
                    <th>Author</th>
                    <th>Merged</th>
                    <th>Written with</th>
                    <th className="num">Lines</th>
                    <th className="num">Est. cost</th>
                    <th className="num">Problems</th>
                    <th className="num">Requests changed</th>
                  </tr>
                </thead>
                <tbody>
                  {prs.map((p) => (
                    <tr key={p.sha} onClick={() => pick(p.sha)} className="clickable">
                      <td>
                        <a href={`https://github.com/${repo}/pull/${p.number}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                          #{p.number}
                        </a>
                      </td>
                      <td>{p.title}</td>
                      <td>{p.author}</td>
                      <td className="mono">{p.date.slice(0, 10)}</td>
                      <td>{p.ai ?? <span className="muted">not marked</span>}</td>
                      <td className="num mono">
                        +{p.added}/−{p.deleted}
                      </td>
                      <td className="num mono">{p.usage.usd ? formatUsd(p.usage.usd) : "—"}</td>
                      <td className="num">
                        {p.introduced > 0 && <span className="badge bad">⚠ {p.introduced}</span>} {p.fixed > 0 && <span className="badge good">✓ {p.fixed}</span>}
                      </td>
                      <td className="num">{p.flowChanges || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            {pushes} commit{pushes === 1 ? "" : "s"} pushed directly to the branch
            {pushes ? `, ${counted.filter((c) => c.landing?.via === "push" && c.delta.newFindings.length).length} of which introduced problems` : ""}. Git
            doesn't record individual pushes, so each direct commit counts as one.
          </p>
        </Section>

        <Section id="architecture" title="Architecture" subtitle="Generated from the code. Play a story to follow one request through it.">
          {arch && arch.components.length > 1 ? (
            <ArchDiagram data={arch} title={repo} subtitle={`${arch.components.length} parts · ${arch.stories.length} requests`} />
          ) : (
            <p className="muted">No HTTP routes found, so there's no request path to draw.</p>
          )}
        </Section>

        <Section id="problems" title="Problems & fixes" subtitle="Every open problem, where it is, why it matters, how to fix it, and a prompt to paste into your AI coding agent.">
          {!report ? (
            <p className="muted">Building fixes…</p>
          ) : problems.length === 0 ? (
            <p className="muted">No open problems found.</p>
          ) : (
            <>
              {report.fixAllPrompt && <PromptBox prompt={report.fixAllPrompt} label={`One prompt to fix all ${problems.length} problems, most severe first`} />}
              <div className="problem-grid">
                {problems.map((p) => (
                  <ProblemCard key={p.id} p={p} repo={repo} onPick={pick} />
                ))}
              </div>
            </>
          )}
        </Section>

        <Section id="people" title="People" subtitle="Who changed the code in this window, and how much of it was marked as AI-written.">
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Author</th>
                  <th className="num">Commits</th>
                  <th className="num">Lines added</th>
                  <th className="num">Marked AI</th>
                  <th className="num">Est. AI cost</th>
                  <th className="num">Problems introduced</th>
                </tr>
              </thead>
              <tbody>
                {spend.byAuthor.map((g) => (
                  <tr key={g.key}>
                    <td>{g.key}</td>
                    <td className="num">{g.commits}</td>
                    <td className="num">{g.linesAdded.toLocaleString()}</td>
                    <td className="num">{g.commits ? Math.round((g.aiCommits / g.commits) * 100) : 0}%</td>
                    <td className="num mono">{g.usage.usd ? formatUsd(g.usage.usd) : "—"}</td>
                    <td className="num">{counted.filter((c) => c.author === g.key).reduce((n, c) => n + c.delta.newFindings.length, 0) || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="hotspots" title="Hotspots & recommendations" subtitle="Files changed most often (where bugs and conflicts concentrate), and what to do first.">
          <div className="grid-auto">
            <div className="table-wrap">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="num">Commits</th>
                    <th className="num">Lines churned</th>
                    <th className="num">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.hotspots.map((h) => (
                    <tr key={h.file}>
                      <td className="mono">{h.file}</td>
                      <td className="num">{h.commits}</td>
                      <td className="num">{h.churn}</td>
                      <td className="num">{h.loc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="recs">
              {analysis.recommendations.map((r) => (
                <li key={r.id} className={`rec rec-${r.priority}`}>
                  <span className={`badge ${r.priority === "high" ? "bad" : ""}`}>{r.priority}</span> <strong>{r.title}</strong>
                  <div className="muted">{r.detail}</div>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      </main>
    </div>
  );
}

function Section({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section id={id} className="report-section card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="section-title">
        {title}
      </h2>
      {subtitle && <p className="muted section-sub">{subtitle}</p>}
      {children}
    </section>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "bad" | "warn" }) {
  return (
    <div className={`kpi${tone ? ` ${tone}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

function AssumptionsPanel({ value: a, onChange }: { value: Assumptions; onChange: (a: Assumptions) => void }) {
  return (
    <details className="assumptions">
      <summary>
        Assumptions: {a.model.label} (${a.model.input}/${a.model.output} per M tokens) · {a.scope === "marked" ? "only commits marked as AI-written" : "every commit, as if AI-written"} · {a.readPerWritten}× context read ·{" "}
        {Math.round(a.cachedShare * 100)}% cached
      </summary>
      <div className="assumption-grid">
        <label>
          Model prices
          <select value={a.model.id} onChange={(e) => onChange({ ...a, model: MODEL_PRICES.find((m) => m.id === e.target.value)! })}>
            {MODEL_PRICES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}: ${m.input} in / ${m.output} out / ${m.cacheRead} cached
              </option>
            ))}
          </select>
        </label>
        <label>
          Which commits count
          <select value={a.scope} onChange={(e) => onChange({ ...a, scope: e.target.value as Assumptions["scope"] })}>
            <option value="marked">Only commits marked as AI-written</option>
            <option value="all">Every commit (upper bound)</option>
          </select>
        </label>
        <label>
          Context read per token written: {a.readPerWritten}×
          <input type="range" min={1} max={100} value={a.readPerWritten} onChange={(e) => onChange({ ...a, readPerWritten: Number(e.target.value) })} />
        </label>
        <label>
          Read tokens served from cache: {Math.round(a.cachedShare * 100)}%
          <input type="range" min={0} max={95} step={5} value={Math.round(a.cachedShare * 100)} onChange={(e) => onChange({ ...a, cachedShare: Number(e.target.value) / 100 })} />
        </label>
        <label>
          Characters per token: {a.charsPerToken}
          <input type="range" min={2.5} max={5} step={0.5} value={a.charsPerToken} onChange={(e) => onChange({ ...a, charsPerToken: Number(e.target.value) })} />
        </label>
      </div>
      <p className="muted small">
        Cost = tokens written × output price + tokens read × (cached share × cache price + the rest × input price). Only code files count; failed attempts that were
        never committed can't be seen, so real spend is usually higher. Your settings are remembered in this browser.
      </p>
    </details>
  );
}

function ProblemCard({ p, repo, onPick }: { p: RepoProblem; repo: string; onPick: (sha: string) => void }) {
  return (
    <article className={`problem sev-${p.severity}`} aria-label={p.title}>
      <div className="problem-head">
        <span className={`badge sev ${p.severity}`}>{p.severity}</span>
        <strong>{p.title}</strong>
      </div>
      {p.where && (
        <div className="mono small">
          <a href={`https://github.com/${repo}/blob/HEAD/${p.where.file}${p.where.line ? `#L${p.where.line}` : ""}`} target="_blank" rel="noopener noreferrer">
            {p.where.file}
            {p.where.line ? `:${p.where.line}` : ""}
          </a>
        </div>
      )}
      <p>{p.why}</p>
      {p.routes && p.routes.length > 1 && <p className="muted small">Affects {p.routes.join(", ")}</p>}
      <ol className="fix-steps">
        {p.fix.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ol>
      {p.introducedIn && (
        <p className="muted small">
          Introduced in{" "}
          <button className="link-button" onClick={() => onPick(p.introducedIn!.sha)}>
            {p.introducedIn.sha.slice(0, 7)} “{p.introducedIn.subject.slice(0, 60)}”
          </button>{" "}
          by {p.introducedIn.author}
          {p.introducedIn.ai ? ` with ${p.introducedIn.ai}` : ""}
          {p.introducedIn.pr ? ` (PR #${p.introducedIn.pr})` : ""}
        </p>
      )}
      <PromptBox prompt={p.prompt} />
    </article>
  );
}

function PullRequestPreview({ repo, number }: { repo: string; number: number }) {
  const [r, setR] = useState<(CompareResult & { base: string; head: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.atlasPullRequest(repo, number).then(setR, (e) => setError(String(e)));
  }, [repo, number]);
  if (error) return <p className="error-text">{error}</p>;
  if (!r) return <p className="muted">Mapping the pull request against its base…</p>;
  if (!r.architecture) return <p className="error-text">The server returned no comparison for this pull request.</p>;
  return (
    <>
      <p>{r.summary}</p>
      <ArchDiagram
        data={{ ...r.architecture, stories: [] }}
        title={`PR #${number}: ${r.base.slice(0, 7)} → ${r.head.slice(0, 7)}`}
        subtitle="Base and PR head on one diagram: green is new, red dashed is gone."
        summary={r.architecture.summary.length ? r.architecture.summary : ["No part of the architecture changed"]}
      />
      <h4>Requests, step by step</h4>
      <FlowChanges flows={r.flows} />
    </>
  );
}

/** One sentence that says what matters most. */
export function headline(
  repo: string,
  analysis: HistoryAnalysis,
  aiCommits: number,
  tools: string[],
  problems: RepoProblem[],
  a: Assumptions,
  usd: number,
): string {
  const n = analysis.commits.length - 1;
  const parts: string[] = [`${repo}: ${n} commit${n === 1 ? "" : "s"} analyzed.`];
  if (aiCommits > 0) {
    parts.push(`${aiCommits} (${Math.round((aiCommits / Math.max(1, n)) * 100)}%) were marked as written with ${tools.slice(0, 3).join(", ")}, roughly ${formatUsd(usd)} at ${a.model.label} prices.`);
  } else {
    parts.push("None were marked as AI-written.");
  }
  const worst = problems.find((p) => p.severity === "critical" || p.severity === "high");
  if (worst) {
    parts.push(
      `Most urgent: ${worst.title}${worst.introducedIn ? `, introduced in ${worst.introducedIn.sha.slice(0, 7)}${worst.introducedIn.ai ? ` (${worst.introducedIn.ai})` : ""}` : ""}.`,
    );
  } else if (problems.length) {
    parts.push(`${problems.length} lower-severity problem${problems.length === 1 ? "" : "s"} to tidy up.`);
  } else {
    parts.push("No open problems found.");
  }
  return parts.join(" ");
}
