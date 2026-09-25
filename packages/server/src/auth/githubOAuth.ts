import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import type { Session, SessionStore } from "./sessions.js";

export const SESSION_COOKIE = "acrv_session";
const STATE_COOKIE = "acrv_oauth_state";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public origin of the dashboard/API, e.g. https://acrv.example.com */
  publicUrl: string;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSec}`,
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface AuthedRequest extends Request {
  session?: Session;
}

/**
 * "Sign in with GitHub" for the dashboard, using the GitHub App's own OAuth
 * credentials. A session records which repos the user can reach through the
 * app's installations -- the API only ever shows reviews for those repos, so
 * access control is exactly GitHub's own.
 */
export function mountGitHubOAuth(
  app: Express,
  config: OAuthConfig,
  sessions: SessionStore,
  fetchImpl: typeof fetch = fetch,
): void {
  const secure = config.publicUrl.startsWith("https://");
  const redirectUri = `${config.publicUrl}/auth/callback`;

  app.get("/auth/login", (_req, res) => {
    const state = randomBytes(24).toString("base64url");
    res.setHeader("Set-Cookie", cookie(STATE_COOKIE, state, { maxAgeSec: 600, secure }));
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    const expected = parseCookies(req.header("cookie"))[STATE_COOKIE];
    const { code, state } = req.query as { code?: string; state?: string };
    if (!expected || !state || !code || !safeEqual(expected, state)) {
      res.status(400).send("Sign-in failed: invalid or expired state. Please try again.");
      return;
    }
    try {
      const token = await exchangeCode(fetchImpl, config, code, redirectUri);
      const login = (await gh<{ login: string }>(fetchImpl, token, "/user")).login;
      const repos = await accessibleRepos(fetchImpl, token);
      const session = await sessions.create(login, repos, SESSION_TTL_MS);
      res.setHeader("Set-Cookie", [
        cookie(SESSION_COOKIE, session.id, { maxAgeSec: SESSION_TTL_MS / 1000, secure }),
        cookie(STATE_COOKIE, "", { maxAgeSec: 0, secure }),
      ]);
      res.redirect(`${config.publicUrl}/`);
    } catch (err) {
      res.status(502).send(`Sign-in failed: ${String(err).split("\n")[0]}`);
    }
  });

  app.post("/auth/logout", async (req: AuthedRequest, res) => {
    if (req.session) await sessions.delete(req.session.id);
    res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure }));
    res.status(204).end();
  });
}

async function exchangeCode(fetchImpl: typeof fetch, config: OAuthConfig, code: string, redirectUri: string): Promise<string> {
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`token exchange failed: ${json.error ?? res.status}`);
  return json.access_token;
}

async function gh<T>(fetchImpl: typeof fetch, token: string, path: string): Promise<T> {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Repos the user can access through installations of this app (capped, to bound session size). */
async function accessibleRepos(fetchImpl: typeof fetch, token: string): Promise<string[]> {
  const repos: string[] = [];
  const { installations } = await gh<{ installations: Array<{ id: number }> }>(fetchImpl, token, "/user/installations?per_page=100");
  for (const inst of installations) {
    for (let page = 1; page <= 10; page++) {
      const { repositories } = await gh<{ repositories: Array<{ full_name: string }> }>(
        fetchImpl,
        token,
        `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
      );
      repos.push(...repositories.map((r) => r.full_name));
      if (repositories.length < 100 || repos.length >= 2000) break;
    }
  }
  return [...new Set(repos)];
}

/** Attaches req.session when the cookie names a live session. */
export function loadSession(sessions: SessionStore) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const id = parseCookies(req.header("cookie"))[SESSION_COOKIE];
    if (id) req.session = await sessions.get(id).catch(() => undefined);
    next();
  };
}

export function requireSession(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.session) return next();
  res.status(401).json({ error: "Sign in required", loginUrl: "/auth/login" });
}

/**
 * CSRF defense for cookie-authenticated writes: browsers always send Origin on
 * cross-site POSTs, so any state-changing request must come from our own origin.
 */
export function requireSameOrigin(publicUrl: string) {
  const allowed = new URL(publicUrl).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (req.header("origin") === allowed) return next();
    res.status(403).json({ error: "Cross-origin request refused" });
  };
}
