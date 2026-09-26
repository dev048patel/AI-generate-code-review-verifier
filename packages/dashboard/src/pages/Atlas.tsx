import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { Architecture, AtlasFinding, AtlasJob, CommitPoint, CompareResult, HistoryAnalysis, RequestFlow, RuntimeView } from "../atlasTypes";
import { ChurnChart, MetricTrend } from "../components/atlas/Charts";
import { GraphMap, MapLegend } from "../components/atlas/GraphMap";
import { ArchDiagram } from "../components/atlas/ArchDiagram";
import { FlowChanges, FlowPlayer } from "../components/atlas/RequestFlow";
import { layoutGraph, runtimeMap, toDiffMaps, toMap, type MapKind, type MapNode } from "../components/atlas/layout";

type Tab = "diagram" | "flows" | "overview" | "map" | "compare" | "live";

const MAP_W = 960;
const MAP_H = 560;
const DIFF_H = 400;

function short(sha: string): string {
  return sha.slice(0, 7);
}

function problems(c: CommitPoint): number {
  return c.metrics.unprotectedAuthRoutes + c.metrics.brokenImports + c.metrics.cycles;
}

export function Atlas() {
  const [params, setParams] = useSearchParams();
  const [repoInput, setRepoInput] = useState(params.get("repo") ?? "gothinkster/node-express-realworld-example-app");
  const [maxCommits, setMaxCommits] = useState(150);
  const [repo, setRepo] = useState<string | null>(params.get("repo"));
  const [job, setJob] = useState<AtlasJob | null>(null);
  const [analysis, setAnalysis] = useState<HistoryAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) ?? "diagram");
  const [compareRange, setCompareRange] = useState<{ from: string; to: string } | null>(() => {
    const from = params.get("from");
    const to = params.get("to");
    return from && to ? { from, to } : null;
  });
  const [prNumber, setPrNumber] = useState(params.get("pr") ?? "");
  const [flowRoute, setFlowRoute] = useState<string | null>(null);

  // Poll the analysis job.
  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.atlasStatus(repo);
        if (cancelled) return;
        if (s.job) setJob(s.job);
        if (s.analysis) setAnalysis(s.analysis);
        if (!s.job || s.job.status === "running") setTimeout(tick, 1000);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [repo]);

  async function analyze() {
    const r = repoInput.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) {
      setError('Enter a repo as "owner/name", e.g. expressjs/express');
      return;
    }
    setError(null);
    setAnalysis(null);
    try {
      const { job: j } = await api.atlasAnalyze(r, maxCommits);
      setJob(j);
      setRepo(r);
      setParams({ repo: r });
    } catch (e) {
      setError(String(e));
    }
  }

  function compareWithParent(c: CommitPoint) {
    if (!analysis) return;
    const i = analysis.commits.findIndex((x) => x.sha === c.sha);
    if (i <= 0) return;
    setCompareRange({ from: analysis.commits[i - 1]!.sha, to: c.sha });
    setTab("compare");
  }

  return (
    <div>
      <div className="card">
        <h2 className="card-title">🗺️ Repo Atlas</h2>
        <p className="muted">
          Map any public repo: how its modules, routes and dependencies fit together, how every commit changed that
          structure, where the gaps are, and how it behaves live.
        </p>
        <form
          className="atlas-form"
          onSubmit={(e) => {
            e.preventDefault();
            void analyze();
          }}
        >
          <label className="field-label" htmlFor="atlas-repo">
            Repository
          </label>
          <input id="atlas-repo" type="text" value={repoInput} onChange={(e) => setRepoInput(e.target.value)} placeholder="owner/name" />
          <label className="field-label" htmlFor="atlas-depth">
            Commits
          </label>
          <select id="atlas-depth" value={maxCommits} onChange={(e) => setMaxCommits(Number(e.target.value))}>
            {[50, 150, 300, 500].map((n) => (
              <option key={n} value={n}>
                last {n}
              </option>
            ))}
          </select>
          <button type="submit" disabled={job?.status === "running"}>
            {job?.status === "running" ? "Analyzing…" : "Analyze"}
          </button>
        </form>
        {error && <p className="error-text">{error}</p>}
        {job?.status === "running" && (
          <div className="scan-panel">
            <div className="scan-bar-track">
              <div className="scan-bar-fill" style={{ width: `${Math.round((job.progress.done / Math.max(1, job.progress.total)) * 100)}%` }} />
            </div>
            <p className="scan-text">
              {job.progress.done === 0 ? "Cloning…" : `Replaying commit ${job.progress.done} of ${job.progress.total}`}
            </p>
          </div>
        )}
        {job?.status === "failed" && <p className="error-text">{job.error}</p>}
      </div>

      {analysis && repo && (
        <>
          <Headline analysis={analysis} />
          <nav className="atlas-tabs" aria-label="Atlas views">
            {(["diagram", "flows", "overview", "map", "compare", "live"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "" : "secondary"} aria-pressed={tab === t} onClick={() => setTab(t)}>
                {{ diagram: "Diagram", flows: "Request flow", overview: "History", map: "Map", compare: "Compare", live: "Live" }[t]}
              </button>
            ))}
          </nav>
          {tab === "diagram" && (
            <DiagramView
              repo={repo}
              onOpenSteps={(routeId) => {
                setFlowRoute(routeId);
                setTab("flows");
              }}
            />
          )}
          {tab === "flows" && <FlowsView repo={repo} initial={flowRoute} />}
          {tab === "overview" && <Overview analysis={analysis} onPick={compareWithParent} />}
          {tab === "map" && <MapView analysis={analysis} />}
          {tab === "compare" && (
            <CompareView repo={repo} analysis={analysis} range={compareRange} setRange={setCompareRange} prNumber={prNumber} setPrNumber={setPrNumber} />
          )}
          {tab === "live" && <LiveView repo={repo} />}
        </>
      )}
    </div>
  );
}

function Headline({ analysis }: { analysis: HistoryAnalysis }) {
  const last = analysis.commits[analysis.commits.length - 1]!;
  const high = analysis.head.findings.filter((f) => f.severity === "high" || f.severity === "critical").length;
  const wastePct = analysis.waste.addedLines ? Math.round((analysis.waste.shortLivedLines / analysis.waste.addedLines) * 100) : 0;
  return (
    <div className="card atlas-stats">
      <Stat label="Modules" value={last.metrics.modules.toLocaleString()} />
      <Stat label="HTTP routes" value={last.metrics.routes.toLocaleString()} />
      <Stat label="Lines of code" value={last.metrics.loc.toLocaleString()} />
      <Stat label="High-severity problems" value={String(high)} tone={high > 0 ? "critical" : undefined} />
      <Stat label={`Thrown away within ${analysis.waste.windowCommits} commits`} value={`${wastePct}%`} note={`≈ ${analysis.waste.estimatedTokens.toLocaleString()} tokens`} />
      <Stat label="Commits analyzed" value={String(analysis.commits.length)} note={analysis.truncated ? "file cap reached" : undefined} />
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "critical" }) {
  return (
    <div className="stat">
      <div className="stat-value" style={tone ? { color: "var(--critical)" } : undefined}>
        {tone === "critical" && <span aria-hidden="true">✕ </span>}
        {value}
      </div>
      <div className="stat-label">{label}</div>
      {note && <div className="muted" style={{ fontSize: 11 }}>{note}</div>}
    </div>
  );
}

function Overview({ analysis, onPick }: { analysis: HistoryAnalysis; onPick: (c: CommitPoint) => void }) {
  const commits = analysis.commits;
  const regressions = commits.filter((c) => c.delta.newFindings.length > 0).reverse();
  return (
    <>
      <div className="card">
        <h3 className="card-title">Recommendations</h3>
        {analysis.recommendations.length === 0 ? (
          <p className="muted">Nothing stands out. 🎉</p>
        ) : (
          analysis.recommendations.map((r) => (
            <div key={r.id} className="finding">
              <div className="finding-title">
                <span className={`severity ${r.priority === "high" ? "high" : r.priority === "medium" ? "medium" : "low"}`}>{r.priority}</span> {r.title}
              </div>
              <p style={{ margin: "4px 0 0" }}>{r.detail}</p>
              {r.files && <div className="finding-loc mono">{r.files.slice(0, 5).join(", ")}</div>}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h3 className="card-title">How the structure changed</h3>
        <p className="muted">Click any point to see what that commit changed.</p>
        <div className="atlas-trends">
          <MetricTrend title="Modules" commits={commits} value={(c) => c.metrics.modules} onPick={onPick} />
          <MetricTrend title="Import links" commits={commits} value={(c) => c.metrics.importEdges} onPick={onPick} />
          <MetricTrend title="HTTP routes" commits={commits} value={(c) => c.metrics.routes} onPick={onPick} />
          <MetricTrend title="Lines of code" commits={commits} value={(c) => c.metrics.loc} onPick={onPick} />
          <MetricTrend title="Open problems (unprotected auth, broken imports, cycles)" commits={commits} value={problems} onPick={onPick} />
          <MetricTrend title="Test files" commits={commits} value={(c) => c.metrics.testModules} onPick={onPick} />
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Churn per commit</h3>
        <ChurnChart commits={commits} onPick={onPick} />
        <details>
          <summary className="muted">Show as table</summary>
          <table className="atlas-table">
            <thead>
              <tr>
                <th>Commit</th>
                <th>Subject</th>
                <th>Added</th>
                <th>Deleted</th>
                <th>Thrown away</th>
              </tr>
            </thead>
            <tbody>
              {commits.slice(1).map((c) => (
                <tr key={c.sha}>
                  <td className="mono">{short(c.sha)}</td>
                  <td>{c.subject.slice(0, 80)}</td>
                  <td>{c.churn.added}</td>
                  <td>{c.churn.deleted}</td>
                  <td>{c.shortLivedLines}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 className="card-title">Commits that introduced problems</h3>
          {regressions.length === 0 ? (
            <p className="muted">None in this window.</p>
          ) : (
            regressions.slice(0, 12).map((c) => (
              <button key={c.sha} className="atlas-row" onClick={() => onPick(c)}>
                <span className="mono">{short(c.sha)}</span> {c.subject.slice(0, 60)}
                <span className="muted"> — {c.delta.newFindings.length} new</span>
              </button>
            ))
          )}
        </div>
        <div className="card">
          <h3 className="card-title">Hotspots</h3>
          {analysis.hotspots.slice(0, 8).map((h) => (
            <div key={h.file} className="atlas-row-static">
              <span className="mono">{h.file}</span>
              <span className="muted">
                {" "}
                {h.commits} commits · {h.churn} lines churned · {h.loc} lines
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function FindingList({ findings, onSelect }: { findings: AtlasFinding[]; onSelect?: (f: AtlasFinding) => void }) {
  if (findings.length === 0) return <p className="muted">No findings.</p>;
  return (
    <div>
      {findings.map((f) => (
        <div key={f.id} className="finding" onClick={() => onSelect?.(f)} style={{ cursor: onSelect ? "pointer" : "default" }}>
          <div className="finding-title">
            <span className={`severity ${f.severity === "info" ? "low" : f.severity}`}>{f.severity}</span> {f.title}
          </div>
          <p style={{ margin: "4px 0 0" }}>{f.detail}</p>
          {f.file && (
            <div className="finding-loc mono">
              {f.file}
              {f.line ? `:${f.line}` : ""}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function kindsOf(nodes: MapNode[]): MapKind[] {
  return [...new Set(nodes.map((n) => n.kind))];
}

function MapView({ analysis }: { analysis: HistoryAnalysis }) {
  const [selected, setSelected] = useState<string | undefined>();
  const map = useMemo(() => toMap(analysis.head), [analysis]);
  const positions = useMemo(() => layoutGraph(map.nodes, map.edges, { width: MAP_W, height: MAP_H }), [map]);
  const collapsed = map.nodes.some((n) => n.kind === "group");
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const findings = [...analysis.head.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <>
      <div className="card">
        <h3 className="card-title">Structure at {short(analysis.head.commit ?? "HEAD")}</h3>
        {collapsed && <p className="muted">Large repo: files are grouped by directory.</p>}
        <GraphMap
          nodes={map.nodes}
          edges={map.edges}
          positions={positions}
          width={MAP_W}
          height={MAP_H}
          title="Dependency map of modules, routes and packages"
          highlight={selected}
          onSelect={(n) => setSelected(n.id)}
        />
        <MapLegend kinds={kindsOf(map.nodes)} />
      </div>
      <div className="card">
        <h3 className="card-title">Gaps and problems ({findings.length})</h3>
        <FindingList
          findings={findings}
          onSelect={(f) => setSelected(collapsed && f.nodeId?.startsWith("m:") ? `g:${analysis.head.nodes.find((n) => n.id === f.nodeId)?.group}` : f.nodeId)}
        />
      </div>
    </>
  );
}

function CompareView({
  repo,
  analysis,
  range,
  setRange,
  prNumber,
  setPrNumber,
}: {
  repo: string;
  analysis: HistoryAnalysis;
  range: { from: string; to: string } | null;
  setRange: (r: { from: string; to: string }) => void;
  prNumber: string;
  setPrNumber: (v: string) => void;
}) {
  const commits = analysis.commits;
  const from = range?.from ?? commits[0]!.sha;
  const to = range?.to ?? commits[commits.length - 1]!.sha;
  const [result, setResult] = useState<(CompareResult & { label: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened from a link (e.g. the browser extension's "Open in Repo Atlas" on a PR): show that PR first.
  const [prFirst, setPrFirst] = useState(Boolean(prNumber) && !range);

  useEffect(() => {
    if (prFirst) {
      setPrFirst(false);
      void loadPr();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .atlasCompare(repo, from, to)
      .then((r) => !cancelled && setResult({ ...r, label: `${short(from)} → ${short(to)}` }))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [repo, from, to]);

  async function loadPr() {
    const n = Number(prNumber);
    if (!Number.isInteger(n) || n <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.atlasPullRequest(repo, n);
      setResult({ ...r, label: `PR #${n} (${short(r.base)} → ${short(r.head)})` });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const option = (c: CommitPoint) => (
    <option key={c.sha} value={c.sha}>
      {short(c.sha)} {c.subject.slice(0, 50)}
    </option>
  );

  return (
    <>
      <div className="card">
        <h3 className="card-title">Compare</h3>
        <div className="atlas-form">
          <label className="field-label" htmlFor="cmp-from">
            Before
          </label>
          <select id="cmp-from" value={from} onChange={(e) => setRange({ from: e.target.value, to })}>
            {commits.map(option)}
          </select>
          <label className="field-label" htmlFor="cmp-to">
            After
          </label>
          <select id="cmp-to" value={to} onChange={(e) => setRange({ from, to: e.target.value })}>
            {commits.map(option)}
          </select>
          <span className="muted">or</span>
          <label className="field-label" htmlFor="cmp-pr">
            Pull request #
          </label>
          <input id="cmp-pr" type="text" inputMode="numeric" value={prNumber} onChange={(e) => setPrNumber(e.target.value)} style={{ width: 80 }} />
          <button className="secondary" onClick={() => void loadPr()}>
            Preview PR
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
        {loading && <p className="muted">Building both maps…</p>}
      </div>
      {result && !loading && <DiffMaps result={result} />}
    </>
  );
}

function DiffMaps({ result }: { result: CompareResult & { label: string } }) {
  const maps = useMemo(() => toDiffMaps(result.before, result.after, result.diff), [result]);
  const positions = useMemo(() => layoutGraph(maps.union.nodes, maps.union.edges, { width: MAP_W, height: DIFF_H }), [maps]);
  const d = result.diff;
  const routeLabels = (list: typeof d.addedNodes) => list.filter((n) => n.kind === "route").map((n) => n.label);
  return (
    <>
      <div className="card">
        <ArchDiagram
          data={{ ...result.architecture, stories: [] }}
          title={`${result.label}: architecture before → after`}
          subtitle="Both versions on one diagram. Green parts and arrows are new, red dashed ones are gone."
          summary={result.architecture.summary.length ? result.architecture.summary : ["No part of the architecture changed"]}
        />
      </div>
      <div className="card">
        <h3 className="card-title">
          {result.label}: how requests changed ({result.flows.length})
        </h3>
        <p className="muted">Each request that now moves through the code differently. Green steps were added by this change, red ones were removed.</p>
        <FlowChanges flows={result.flows} />
      </div>
      <div className="card">
        <h3 className="card-title">{result.label}: structure</h3>
        <p>{result.summary}</p>
        <div className="grid-2">
          <div>
            <div className="stat-label">Introduced ({d.newFindings.length})</div>
            <FindingList findings={d.newFindings} />
          </div>
          <div>
            <div className="stat-label">Fixed ({d.resolvedFindings.length})</div>
            <FindingList findings={d.resolvedFindings} />
            {(routeLabels(d.addedNodes).length > 0 || routeLabels(d.removedNodes).length > 0) && (
              <>
                <div className="stat-label" style={{ marginTop: 12 }}>
                  Routes
                </div>
                {routeLabels(d.addedNodes).map((r) => (
                  <div key={`+${r}`} className="mono">
                    + {r}
                  </div>
                ))}
                {routeLabels(d.removedNodes).map((r) => (
                  <div key={`-${r}`} className="mono">
                    − {r}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="card">
        <h3 className="card-title">Before</h3>
        <GraphMap nodes={maps.before.nodes} edges={maps.before.edges} positions={positions} width={MAP_W} height={DIFF_H} title="Map before the change" />
        <h3 className="card-title" style={{ marginTop: 16 }}>
          After
        </h3>
        <GraphMap nodes={maps.after.nodes} edges={maps.after.edges} positions={positions} width={MAP_W} height={DIFF_H} title="Map after the change" />
        <MapLegend kinds={kindsOf(maps.union.nodes)} statuses />
      </div>
    </>
  );
}

function DiagramView({ repo, onOpenSteps }: { repo: string; onOpenSteps: (routeId: string) => void }) {
  const [arch, setArch] = useState<Architecture | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setArch(null);
    api
      .atlasArchitecture(repo)
      .then((a) => !cancelled && setArch(a))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo]);
  if (error) return <div className="card error-text">{error}</div>;
  if (!arch) return <div className="card muted">Drawing the architecture from the code…</div>;
  if (arch.components.length <= 1) {
    return <div className="card muted">No HTTP routes found, so there's no request path to draw. The Map and History tabs still apply.</div>;
  }
  const gaps = arch.components.filter((c) => c.type === "gap").length;
  return (
    <div className="card">
      <ArchDiagram
        data={arch}
        title={repo}
        subtitle={`${arch.components.length} parts · ${arch.stories.length} requests${gaps ? ` · ⚠ ${gaps} missing safeguard${gaps > 1 ? "s" : ""}` : ""} · generated from the code`}
        onOpenSteps={onOpenSteps}
        shareable
      />
    </div>
  );
}

function FlowsView({ repo, initial }: { repo: string; initial?: string | null }) {
  const [flows, setFlows] = useState<RequestFlow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFlows(null);
    api
      .atlasFlows(repo)
      .then((f) => {
        if (cancelled) return;
        setFlows(f);
        // Start on the request most worth looking at: an unprotected login, else any request with a gap.
        const serious = (x: RequestFlow) => x.steps.some((s) => s.severity === "high");
        const first =
          (initial ? f.find((x) => x.routeId === initial) : undefined) ??
          f.find((x) => serious(x) && /log-?in|sign-?in/i.test(x.path)) ?? f.find(serious) ?? f.find((x) => x.steps.some((s) => s.kind === "missing")) ?? f[0];
        setSelected(first?.routeId ?? null);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo, initial]);

  if (error) return <div className="card error-text">{error}</div>;
  if (!flows) return <div className="card muted">Tracing every request through the code…</div>;
  if (flows.length === 0) {
    return (
      <div className="card muted">
        No HTTP routes found. Request flows cover Express-style routers (Express, Fastify, Koa, Hono) and Next.js route handlers.
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const shown = flows.filter((f) => !q || `${f.method} ${f.path}`.toLowerCase().includes(q));
  const flow = flows.find((f) => f.routeId === selected) ?? flows[0]!;
  return (
    <div className="flows-layout">
      <div className="card flows-list">
        <input type="search" placeholder="Filter routes…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter routes" />
        <ul>
          {shown.map((f) => {
            const warn = f.steps.filter((s) => s.kind === "missing");
            return (
              <li key={f.routeId}>
                <button className={`flows-item${f.routeId === flow.routeId ? " selected" : ""}`} onClick={() => setSelected(f.routeId)}>
                  <span className={`method method-${f.method.toLowerCase()}`}>{f.method}</span>
                  <span className="flows-path">{f.path}</span>
                  {warn.length > 0 && (
                    <span className={`flows-warn${warn.some((w) => w.severity === "high") ? " high" : ""}`} title={warn.map((w) => w.title).join(", ")}>
                      ⚠ {warn.length}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="card">
        <FlowPlayer flow={flow} />
      </div>
    </div>
  );
}

function LiveView({ repo }: { repo: string }) {
  const [view, setView] = useState<RuntimeView | null>(null);
  const [connected, setConnected] = useState(false);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(api.atlasRuntimeUrl(repo));
    source.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => setView(JSON.parse(e.data as string) as RuntimeView);
    return () => es.close();
  }, [repo]);

  const map = useMemo(() => (view ? runtimeMap(view) : { nodes: [], edges: [] }), [view]);
  const positions = useMemo(() => layoutGraph(map.nodes, map.edges, { width: MAP_W, height: 460 }), [map]);
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-acrv-host";

  return (
    <>
      <div className="card">
        <h3 className="card-title">
          Live traffic <span className={`badge ${connected ? "live" : ""}`}>{connected ? "● connected" : "○ waiting"}</span>
        </h3>
        {!view || view.snapshot.spans === 0 ? (
          <>
            <p className="muted">
              No traces yet. Instrument the app with OpenTelemetry and point its exporter here. Every request then shows up
              on this map with its timing:
            </p>
            <pre className="finding-evidence">{`npm install @opentelemetry/auto-instrumentations-node
OTEL_SERVICE_NAME=my-app \\
OTEL_TRACES_EXPORTER=otlp \\
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \\
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${origin}/v1/traces?repo=${repo}" \\
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <ACRV_TRACE_TOKEN>" \\
node --require @opentelemetry/auto-instrumentations-node/register server.js`}</pre>
          </>
        ) : (
          <>
            <p className="muted">{view.snapshot.spans.toLocaleString()} spans received. Edge labels show how long the caller waited (p95).</p>
            <GraphMap nodes={map.nodes} edges={map.edges} positions={positions} width={MAP_W} height={460} title="Live call graph" labelAll />
            <MapLegend kinds={kindsOf(map.nodes)} />
          </>
        )}
      </div>
      {view && view.snapshot.edges.length > 0 && (
        <div className="card">
          <h3 className="card-title">Calls</h3>
          <table className="atlas-table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Calls</th>
                <th>p50</th>
                <th>p95</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {[...view.snapshot.edges]
                .sort((a, b) => b.p95Ms - a.p95Ms)
                .map((e) => (
                  <tr key={`${e.from}>${e.to}`}>
                    <td className="mono">{e.from.replace(/^\w+:/, "")}</td>
                    <td className="mono">{e.to.replace(/^\w+:/, "")}</td>
                    <td>{e.calls}</td>
                    <td>{e.p50Ms}ms</td>
                    <td>{e.p95Ms}ms</td>
                    <td>{e.errors > 0 ? `✕ ${e.errors}` : "0"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {view?.coverage && (
        <div className="grid-2">
          <div className="card">
            <h3 className="card-title">Routes in the code that never ran ({view.coverage.neverCalled.length})</h3>
            {view.coverage.neverCalled.slice(0, 30).map((r) => (
              <div key={r} className="mono">
                {r}
              </div>
            ))}
          </div>
          <div className="card">
            <h3 className="card-title">Seen at runtime, missing from the code map ({view.coverage.unknownAtRuntime.length})</h3>
            {view.coverage.unknownAtRuntime.slice(0, 30).map((r) => (
              <div key={r} className="mono">
                {r}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
