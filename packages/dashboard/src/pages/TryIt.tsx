import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { FixtureSummary } from "../types";

export function TryIt() {
  const [fixtures, setFixtures] = useState<FixtureSummary[]>([]);
  const [selectedFixture, setSelectedFixture] = useState<string>("");
  const [repo, setRepo] = useState("demo/repo");
  const [prTitle, setPrTitle] = useState("");
  const [prDescription, setPrDescription] = useState("");
  const [diffText, setDiffText] = useState("");
  const [loadedFixtureDiff, setLoadedFixtureDiff] = useState("");
  const [afterFileContents, setAfterFileContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.listFixtures().then((r) => setFixtures(r.fixtures));
  }, []);

  async function loadFixture(id: string) {
    setSelectedFixture(id);
    if (!id) return;
    const fixture = await api.getFixtureDiff(id);
    setPrTitle(fixture.prTitle);
    setPrDescription(fixture.prDescription);
    setDiffText(fixture.diffText);
    setLoadedFixtureDiff(fixture.diffText);
    setAfterFileContents(fixture.afterFileContents);
  }

  async function run() {
    setLoading(true);
    setError(null);
    try {
      // An unedited fixture is reviewed server-side from the repo's own copy (trusted, so its tests run);
      // anything edited by hand is arbitrary code and only executes if the server has an isolated sandbox.
      const { review } =
        selectedFixture && diffText === loadedFixtureDiff
          ? await api.runFixtureReview(selectedFixture)
          : await api.simulateDiff({ repo, prTitle, prDescription, diffText, afterFileContents });
      navigate(`/reviews/${review.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2 className="card-title">🎮 Select a challenger</h2>
        <p className="muted">
          Pick one of the evaluation harness's fixtures to see the full pipeline run against a known bug, or edit the
          diff below and run your own.
        </p>
        <select value={selectedFixture} onChange={(e) => loadFixture(e.target.value)}>
          <option value="">— choose an example —</option>
          {fixtures.map((f) => (
            <option key={f.id} value={f.id}>
              {f.id} {f.isCleanControl ? "(clean control)" : `(${f.categories.join(", ")})`}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <h2 className="card-title">📝 Review this diff</h2>
        <label className="stat-label" htmlFor="repo-input">
          Repo
        </label>
        <div style={{ marginBottom: 10 }}>
          <input id="repo-input" type="text" value={repo} onChange={(e) => setRepo(e.target.value)} />
        </div>

        <label className="stat-label" htmlFor="title-input">
          PR title
        </label>
        <div style={{ marginBottom: 10 }}>
          <input
            id="title-input"
            type="text"
            style={{ width: "100%" }}
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
          />
        </div>

        <label className="stat-label" htmlFor="diff-input">
          Unified diff
        </label>
        <textarea
          id="diff-input"
          className="diff"
          value={diffText}
          onChange={(e) => setDiffText(e.target.value)}
          placeholder={"diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n..."}
        />

        {error && (
          <p className="muted" style={{ color: "var(--status-critical)" }}>
            {error}
          </p>
        )}

        <div style={{ marginTop: 12 }}>
          <button onClick={run} disabled={loading || !diffText || Object.keys(afterFileContents).length === 0}>
            {loading ? "Running review…" : "Run review"}
          </button>
        </div>
        {diffText && Object.keys(afterFileContents).length === 0 && (
          <p className="muted" style={{ marginTop: 8 }}>
            Note: running a hand-edited diff needs matching "after" file content, which this simple form only fills
            in when you pick an example above.
          </p>
        )}
      </div>
    </div>
  );
}
