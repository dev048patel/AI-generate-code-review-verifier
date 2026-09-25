import { createSign } from "node:crypto";

const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** The app's own short-lived (<=10 min) RS256 JWT, used only to mint installation tokens. */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdate 60s for clock skew; GitHub rejects exp more than 10 minutes out.
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

export interface InstallationTokenRequest {
  installationId: number;
  /** Narrow the token to just the repo under review. */
  repository?: string;
  /** Narrow the token's permissions below the app's grant. */
  permissions?: Record<string, "read" | "write">;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export type FetchLike = typeof fetch;

/**
 * Mints and caches GitHub App installation tokens. Each token is scoped to
 * one repository and to the least permissions the review needs, and is
 * refreshed five minutes before GitHub expires it (tokens last one hour).
 */
export class GitHubAppAuth {
  private cache = new Map<string, CachedToken>();

  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppAuth | undefined {
    const appId = env.GITHUB_APP_ID;
    const key = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!appId || !key) return undefined;
    return new GitHubAppAuth(appId, key);
  }

  async installationToken(req: InstallationTokenRequest): Promise<string> {
    const key = JSON.stringify([req.installationId, req.repository ?? "*", req.permissions ?? {}]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > 5 * 60_000) return cached.token;

    const body: Record<string, unknown> = {};
    if (req.repository) body.repositories = [req.repository];
    if (req.permissions) body.permissions = req.permissions;
    const res = await this.fetchImpl(`${GITHUB_API}/app/installations/${req.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${createAppJwt(this.appId, this.privateKeyPem, Math.floor(this.now() / 1000))}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub installation token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { token: string; expires_at: string };
    this.cache.set(key, { token: json.token, expiresAt: Date.parse(json.expires_at) });
    return json.token;
  }
}

/** What a review job needs: read the code, write the check run and the PR comment. Nothing else. */
export const REVIEW_TOKEN_PERMISSIONS: Record<string, "read" | "write"> = {
  contents: "read",
  pull_requests: "write",
  checks: "write",
  metadata: "read",
};
