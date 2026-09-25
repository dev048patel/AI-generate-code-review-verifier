import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { OpenPullRequestSummary } from "../types";

const EXAMPLE_REPOS = ["sindresorhus/ky", "sindresorhus/execa", "vitejs/vite", "expressjs/express"];

export function LiveGithub() {
  const [repoInput, setRepoInput] = useState("sindresorhus/ky");
  const [prs, setPrs] = useState<OpenPullRequestSummary[] | null>(null);
  const [prNumberInput, setPrNumberInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  function parseRepo(): [string, string] | null {
    const parts = repoInput.trim().split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return [parts[0], parts[1]];
  }

  async function scan() {
    const parsed = parseRepo();
    if (!parsed) {
      setError('Enter a repo as "owner/name", e.g. sindresorhus/ky');
      return;
    }
    setError(null);
    setSearching(true);
    setPrs(null);
    try {
      const [owner, repo] = parsed;
      const { pullRequests } = await api.listOpenPullRequests(owner, repo);
      setPrs(pullRequests);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function analyze(prNumber: number) {
    const parsed = parseRepo();
    if (!parsed) return;
    setError(null);
    setAnalyzing(true);
    try {
      const [owner, repo] = parsed;
      const { review } = await api.runLiveReview(owner, repo, prNumber);
      navigate(`/reviews/${review.id}`);
    } catch (e) {
      setError(String(e));
      setAnalyzing(false);
    }
  }

  if (analyzing) {
    return (
      <div className="card scan-panel">
        <div className="scan-text crt-flicker">⚡ ANALYZING LIVE PULL REQUEST…</div>
        <div className="scan-bar-track">
          <div className="scan-bar-fill" />
        </div>
        <p className="muted" style={{ marginTop: 16 }}>
          Fetching the real diff, running LLM risk analysis, generating tests, and mutation-testing them. This can
          take 10–30s for larger PRs.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2 className="card-title">⚡ Live GitHub scan</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Point this at any real public GitHub repo. It fetches an actual pull request, runs the full pipeline
          against it, and shows you the trust score — read-only, no comment is posted back to the repo.
        </p>

        <label className="field-label" htmlFor="repo-input">
          Repository (owner/name)
        </label>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            id="repo-input"
            type="text"
            style={{ flex: 1 }}
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && scan()}
            placeholder="owner/name"
          />
          <button onClick={scan} disabled={searching}>
            {searching ? "Scanning…" : "Scan repo"}
          </button>
        </div>

        <div className="legend" style={{ marginTop: 0 }}>
          {EXAMPLE_REPOS.map((r) => (
            <a key={r} href="#" onClick={(e) => { e.preventDefault(); setRepoInput(r); }}>
              {r}
            </a>
          ))}
        </div>

        {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
      </div>

      {searching && (
        <div className="card">
          <span className="spinner" /> Fetching open pull requests…
        </div>
      )}

      {prs && (
        <div className="card">
          <h3 className="card-title">Open pull requests ({prs.length})</h3>
          {prs.length === 0 ? (
            <div className="empty-state">
              <p>No open PRs found on this repo right now.</p>
              <p className="muted">Try a number directly below, e.g. a merged PR you know the number of.</p>
            </div>
          ) : (
            <div className="pr-list">
              {prs.map((pr) => (
                <div key={pr.number} className="pr-row" onClick={() => analyze(pr.number)}>
                  <div>
                    <div className="pr-row-title">#{pr.number} {pr.title}</div>
                    <div className="pr-row-meta">
                      by {pr.authorLogin} · updated {new Date(pr.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button>Analyze →</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Or analyze a specific PR number</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            placeholder="PR number, e.g. 877"
            value={prNumberInput}
            onChange={(e) => setPrNumberInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && /^\d+$/.test(prNumberInput) && analyze(Number(prNumberInput))}
          />
          <button
            className="secondary"
            disabled={!/^\d+$/.test(prNumberInput)}
            onClick={() => analyze(Number(prNumberInput))}
          >
            Analyze PR #{prNumberInput || "?"}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Works for merged/closed PRs too, not just open ones — useful for re-analyzing a real historical PR.
        </p>
      </div>
    </div>
  );
}
