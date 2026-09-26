import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { CommitFix, CommitPoint, CompareResult, RepoProblem } from "../../atlasTypes";
import { commitUsage, formatTokens, formatUsd, type Assumptions } from "../../report/usage";
import { ArchDiagram } from "../atlas/ArchDiagram";
import { FlowChanges } from "../atlas/RequestFlow";
import { PromptBox } from "./PromptBox";

type Filter = "all" | "ai" | "pr" | "push" | "broke" | "fixed" | "requests";

const FILTERS: Array<{ id: Filter; label: string; test: (c: CommitPoint) => boolean }> = [
  { id: "all", label: "All", test: () => true },
  { id: "ai", label: "AI-written", test: (c) => Boolean(c.ai) },
  { id: "pr", label: "Pull requests", test: (c) => c.landing?.via === "pr" },
  { id: "push", label: "Direct pushes", test: (c) => c.landing?.via === "push" },
  { id: "broke", label: "Introduced problems", test: (c) => c.delta.newFindings.length > 0 },
  { id: "fixed", label: "Fixed problems", test: (c) => c.delta.resolvedFindings.length > 0 },
  { id: "requests", label: "Changed requests", test: (c) => (c.flowChanges?.length ?? 0) > 0 },
];

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Every commit, newest first, and for the selected one the whole story:
 * who wrote it (and with which AI tool), how it landed, what it cost, what
 * it did to requests and to the architecture, what it broke or fixed, and
 * a prompt to fix what it broke.
 */
export function CommitExplorer({
  repo,
  commits,
  assumptions,
  fixes,
  problems,
  selected,
  onSelect,
}: {
  repo: string;
  commits: CommitPoint[];
  assumptions: Assumptions;
  fixes: CommitFix[];
  problems: RepoProblem[];
  selected: string | null;
  onSelect: (sha: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const newestFirst = useMemo(() => [...commits].reverse(), [commits]);
  const test = FILTERS.find((f) => f.id === filter)!.test;
  const q = query.trim().toLowerCase();
  const shown = newestFirst.filter((c) => test(c) && (!q || `${c.sha} ${c.subject} ${c.author} ${c.ai?.tool ?? ""} #${c.landing?.pr ?? ""}`.toLowerCase().includes(q)));
  const current = commits.find((c) => c.sha === selected) ?? newestFirst[0];

  return (
    <div className="commits">
      <div className="commit-list-pane">
        <div className="chip-row" role="group" aria-label="Filter commits">
          {FILTERS.map((f) => {
            const n = commits.filter(f.test).length;
            return (
              <button key={f.id} className={`chip${filter === f.id ? " on" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} disabled={n === 0 && f.id !== "all"}>
                {f.label} <span className="chip-n">{n}</span>
              </button>
            );
          })}
        </div>
        <input type="search" placeholder="Search message, author, sha, #PR…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search commits" />
        <ol className="commit-list">
          {shown.map((c) => {
            const u = commitUsage(c, assumptions);
            return (
              <li key={c.sha}>
                <button className={`commit-row${current?.sha === c.sha ? " selected" : ""}`} onClick={() => onSelect(c.sha)}>
                  <span className="commit-row-top">
                    <span className="mono muted">{short(c.sha)}</span>
                    <span className="commit-subject">{c.subject}</span>
                  </span>
                  <span className="commit-row-meta">
                    <span>{c.author}</span>
                    <span>{c.date.slice(0, 10)}</span>
                    {c.landing?.pr ? <span className="badge">#{c.landing.pr}</span> : <span className="badge dim">push</span>}
                    {c.ai && <span className="badge ai">{c.ai.tool}</span>}
                    {c.bot && <span className="badge dim">{c.bot}</span>}
                    <span className="mono">
                      +{c.churn.added}/−{c.churn.deleted}
                    </span>
                    {u.usd > 0 && <span className="mono">{formatUsd(u.usd)}</span>}
                    {c.delta.newFindings.length > 0 && <span className="badge bad">⚠ {c.delta.newFindings.length}</span>}
                    {c.delta.resolvedFindings.length > 0 && <span className="badge good">✓ {c.delta.resolvedFindings.length}</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="muted">No commits match.</li>}
        </ol>
      </div>
      {current && (
        <CommitDetail
          key={current.sha}
          repo={repo}
          commit={current}
          parent={commits[commits.findIndex((c) => c.sha === current.sha) - 1]}
          assumptions={assumptions}
          fix={fixes.find((f) => f.sha === current.sha)}
          problems={problems}
        />
      )}
    </div>
  );
}

function CommitDetail({
  repo,
  commit: c,
  parent,
  assumptions,
  fix,
  problems,
}: {
  repo: string;
  commit: CommitPoint;
  parent?: CommitPoint;
  assumptions: Assumptions;
  fix?: CommitFix;
  problems: RepoProblem[];
}) {
  const [cmp, setCmp] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const u = commitUsage(c, assumptions);
  const open = new Set(problems.map((p) => p.id));

  useEffect(() => {
    setCmp(null);
    setError(null);
  }, [c.sha]);

  const loadCompare = async () => {
    if (!parent) return;
    setLoading(true);
    try {
      setCmp(await api.atlasCompare(repo, parent.sha, c.sha));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <article className="commit-detail" aria-label={`Commit ${short(c.sha)}`}>
      <header>
        <div className="commit-detail-title">{c.subject}</div>
        <div className="muted">
          <a href={`https://github.com/${repo}/commit/${c.sha}`} target="_blank" rel="noopener noreferrer" className="mono">
            {short(c.sha)}
          </a>{" "}
          · {c.author} · {new Date(c.date).toLocaleString()} ·{" "}
          {c.landing?.pr ? (
            <a href={`https://github.com/${repo}/pull/${c.landing.pr}`} target="_blank" rel="noopener noreferrer">
              PR #{c.landing.pr}
            </a>
          ) : (
            "pushed directly"
          )}
        </div>
      </header>

      <div className="mini-stats">
        <div>
          <span className="stat-label">Lines</span>
          <strong>
            +{c.churn.added} / −{c.churn.deleted}
          </strong>
          <span className="muted">{c.churn.files} files</span>
        </div>
        <div>
          <span className="stat-label">Written by</span>
          <strong>{c.ai ? c.ai.tool : c.bot ? c.bot : "Not marked as AI"}</strong>
          {c.ai && <span className="muted small" title={c.ai.evidence}>{c.ai.evidence}</span>}
        </div>
        <div>
          <span className="stat-label">Estimated AI cost</span>
          <strong>{u.usd > 0 ? formatUsd(u.usd) : "—"}</strong>
          <span className="muted">{u.written > 0 ? `${formatTokens(u.written)} out · ${formatTokens(u.read)} in` : assumptions.scope === "marked" ? "not counted: not marked AI" : ""}</span>
        </div>
        <div>
          <span className="stat-label">Thrown away soon after</span>
          <strong>{c.shortLivedLines} lines</strong>
          <span className="muted">deleted within a few commits of being written</span>
        </div>
      </div>

      {(c.architecture?.length ?? 0) > 0 && (
        <section>
          <h4>What it changed in the architecture</h4>
          <div className="arch-summary">
            {c.architecture!.map((s) => (
              <span key={s} className={`arch-chip ${s.startsWith("⚠") || s.startsWith("−") ? "bad" : "good"}`}>
                {s}
              </span>
            ))}
          </div>
        </section>
      )}

      {(c.flowChanges?.length ?? 0) > 0 && (
        <section>
          <h4>How requests move differently</h4>
          <ul className="flow-summaries">
            {c.flowChanges!.map((f) => (
              <li key={f.label}>
                <span className={`badge ${f.status === "added" ? "good" : f.status === "removed" ? "bad" : ""}`}>{f.status === "added" ? "new" : f.status === "removed" ? "gone" : "changed"}</span>{" "}
                <span className="mono">{f.label}</span> <span className="muted">{f.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(c.delta.introduced?.length ?? 0) + c.delta.resolvedFindings.length > 0 && (
        <section className="grid-2">
          <div>
            <h4>Introduced ({c.delta.newFindings.length})</h4>
            <ul className="finding-mini">
              {(c.delta.introduced ?? []).map((f) => (
                <li key={f.id} className={`sev-${f.severity}`}>
                  <span className={`badge sev ${f.severity}`}>{f.severity}</span> {f.title}{" "}
                  {open.has(f.id) ? <span className="badge bad">still open</span> : <span className="badge good">fixed later</span>}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Fixed ({c.delta.resolvedFindings.length})</h4>
            <ul className="finding-mini">
              {c.delta.resolvedFindings.map((id) => (
                <li key={id}>✓ {id.replace(/^[a-z-]+:/, "")}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {fix?.prompt && <PromptBox prompt={fix.prompt} label={`Prompt to fix what ${short(c.sha)} broke (${fix.open.length} still open)`} open />}
      {fix && !fix.prompt && fix.fixedLater.length > 0 && <p className="muted">Everything this commit broke was fixed by a later commit.</p>}

      {parent && (
        <section>
          {!cmp && (
            <button className="secondary" onClick={() => void loadCompare()} disabled={loading}>
              {loading ? "Drawing both versions…" : "Show the before / after diagram"}
            </button>
          )}
          {error && <p className="error-text">{error}</p>}
          {cmp && (
            <>
              <ArchDiagram
                data={{ ...cmp.architecture, stories: [] }}
                title={`${short(parent.sha)} → ${short(c.sha)}`}
                subtitle="Both versions on one diagram: green is new, red dashed is gone."
                summary={cmp.architecture.summary.length ? cmp.architecture.summary : ["No part of the architecture changed"]}
              />
              <h4>Requests, step by step</h4>
              <FlowChanges flows={cmp.flows} />
            </>
          )}
        </section>
      )}
    </article>
  );
}
