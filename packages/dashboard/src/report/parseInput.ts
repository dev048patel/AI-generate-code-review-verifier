/**
 * Whatever someone pastes (a repo URL, a PR, a commit, a file link, a clone
 * URL, or just owner/name) becomes the repo plus what to open first.
 */
export interface ReportTarget {
  repo: string;
  pr?: number;
  sha?: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const RESERVED = new Set(["settings", "orgs", "marketplace", "notifications", "pulls", "issues", "explore", "topics", "sponsors", "login", "new", "search", "features", "enterprise", "about"]);

export function parseRepoInput(raw: string): ReportTarget | undefined {
  let s = raw.trim();
  if (!s) return undefined;
  // git@github.com:owner/repo.git
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) s = `https://github.com/${ssh[1]}/${ssh[2]}`;
  if (/^(www\.)?github\.com\//i.test(s)) s = `https://${s}`;

  let parts: string[];
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return undefined;
    }
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return undefined;
    parts = u.pathname.split("/").filter(Boolean);
  } else {
    parts = s.split("/").filter(Boolean);
    if (parts.length !== 2) return undefined;
  }
  const [owner, rawRepo, kind, id] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || RESERVED.has(owner.toLowerCase()) || !NAME.test(owner) || !NAME.test(repo)) return undefined;
  const target: ReportTarget = { repo: `${owner}/${repo}` };
  if ((kind === "pull" || kind === "pulls") && id && /^\d+$/.test(id)) target.pr = Number(id);
  if (kind === "commit" && id && /^[0-9a-f]{7,40}$/i.test(id)) target.sha = id.toLowerCase();
  return target;
}
