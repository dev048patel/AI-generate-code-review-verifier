/** Pure logic shared by the content script, background worker and tests. */

export interface GithubLocation {
  owner: string;
  repo: string;
  pr?: number;
}

const RESERVED = new Set(["settings", "orgs", "marketplace", "notifications", "pulls", "issues", "explore", "topics", "sponsors", "login", "new", "search", "features", "enterprise", "about"]);

/** github.com/<owner>/<repo>[/pull/<n>[/...]] -> location; anything else -> undefined. */
export function parseGithubUrl(url: string): GithubLocation | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.hostname !== "github.com") return undefined;
  const [owner, repo, kind, num] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repo || RESERVED.has(owner) || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  if (kind === "pull" && num && /^\d+$/.test(num)) return { owner, repo, pr: Number(num) };
  return { owner, repo };
}

export function atlasUrl(server: string, loc: GithubLocation): string {
  const u = new URL("/atlas", server);
  u.searchParams.set("repo", `${loc.owner}/${loc.repo}`);
  if (loc.pr) {
    u.searchParams.set("tab", "compare");
    u.searchParams.set("pr", String(loc.pr));
  }
  return u.toString();
}

export function apiUrl(server: string, loc: GithubLocation & { pr: number }): string {
  return new URL(`/api/atlas/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}/pulls/${loc.pr}`, server).toString();
}

export interface Finding {
  severity: string;
  title: string;
  file?: string;
  line?: number;
}

export interface PrImpact {
  summary: string;
  diff: {
    newFindings: Finding[];
    resolvedFindings: Finding[];
    addedNodes: Array<{ kind: string; label: string }>;
    removedNodes: Array<{ kind: string; label: string }>;
  };
  /** Requests whose path through the code changes: "POST /login: − checks the password". */
  flows?: Array<{ label: string; status: string; summary: string }>;
  /** Parts of the architecture the PR adds or removes: "+ Password hashing", "⚠ now: no rate limiter". */
  architecture?: { summary: string[] };
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  // textContent only: summaries and titles contain names from someone else's repo.
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

/** The panel shown on a PR page. */
export function renderPanel(doc: Document, impact: PrImpact, link: string): HTMLElement {
  const panel = el(doc, "div", undefined, "acrv-panel");
  panel.dataset.acrv = "panel";
  panel.append(el(doc, "h3", "🗺️ Repo Atlas: what this PR changes"), el(doc, "div", impact.summary));

  const serious = impact.diff.newFindings.filter((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
  if (serious.length > 0) {
    const ul = el(doc, "ul");
    for (const f of serious.slice(0, 6)) {
      ul.append(el(doc, "li", `${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`, "acrv-bad"));
    }
    if (serious.length > 6) ul.append(el(doc, "li", `…and ${serious.length - 6} more`, "acrv-muted"));
    panel.append(ul);
  }
  if (impact.diff.resolvedFindings.length > 0) {
    panel.append(el(doc, "div", `Fixes ${impact.diff.resolvedFindings.length} existing problem(s).`, "acrv-good"));
  }
  const routes = (list: PrImpact["diff"]["addedNodes"]) => list.filter((n) => n.kind === "route").map((n) => n.label);
  const added = routes(impact.diff.addedNodes);
  const removed = routes(impact.diff.removedNodes);
  if (added.length || removed.length) {
    panel.append(
      el(
        doc,
        "div",
        [added.length ? `New routes: ${added.slice(0, 5).join(", ")}` : "", removed.length ? `Removed routes: ${removed.slice(0, 5).join(", ")}` : ""]
          .filter(Boolean)
          .join(" · "),
        "acrv-muted",
      ),
    );
  }
  const arch = impact.architecture?.summary ?? [];
  if (arch.length > 0) {
    panel.append(
      el(doc, "div", `Architecture: ${arch.slice(0, 6).join(" · ")}${arch.length > 6 ? ` · …${arch.length - 6} more` : ""}`, arch.some((x) => x.startsWith("⚠")) ? "acrv-bad" : "acrv-muted"),
    );
  }
  const flows = impact.flows ?? [];
  if (flows.length > 0) {
    panel.append(el(doc, "div", `How requests change (${flows.length}):`, "acrv-label"));
    const ul = el(doc, "ul");
    for (const f of flows.slice(0, 5)) {
      ul.append(el(doc, "li", `${f.label}: ${f.summary}`, f.summary.includes("⚠") ? "acrv-bad" : undefined));
    }
    if (flows.length > 5) ul.append(el(doc, "li", `…and ${flows.length - 5} more`, "acrv-muted"));
    panel.append(ul);
  }
  const a = el(doc, "a", "Open the before / after diagram →");
  a.href = link;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  panel.append(a);
  return panel;
}

export function renderMessage(doc: Document, text: string, link?: string): HTMLElement {
  const panel = el(doc, "div", undefined, "acrv-panel");
  panel.dataset.acrv = "panel";
  panel.append(el(doc, "div", text, "acrv-muted"));
  if (link) {
    const a = el(doc, "a", "Open Repo Atlas settings");
    a.href = link;
    a.target = "_blank";
    panel.append(a);
  }
  return panel;
}

/** Only http(s) origins are accepted as a server; anything else could turn the extension into an open redirect. */
export function normalizeServer(input: string): string | undefined {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}
