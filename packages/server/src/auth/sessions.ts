import { randomBytes } from "node:crypto";
import type pg from "pg";

export interface Session {
  id: string;
  login: string;
  /** "owner/name" of every repo the user can access through an installation of this app. */
  repos: string[];
  expiresAt: number;
}

export interface SessionStore {
  create(login: string, repos: string[], ttlMs: number): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  delete(id: string): Promise<void>;
}

function newId(): string {
  return randomBytes(32).toString("base64url");
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  constructor(private readonly now: () => number = Date.now) {}

  async create(login: string, repos: string[], ttlMs: number): Promise<Session> {
    const session = { id: newId(), login, repos, expiresAt: this.now() + ttlMs };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(login: string, repos: string[], ttlMs: number): Promise<Session> {
    const session = { id: newId(), login, repos, expiresAt: Date.now() + ttlMs };
    await this.pool.query("INSERT INTO sessions (id, login, repos, expires_at) VALUES ($1, $2, $3, $4)", [
      session.id,
      login,
      JSON.stringify(repos),
      new Date(session.expiresAt),
    ]);
    // Opportunistic cleanup keeps the table small without a cron job.
    await this.pool.query("DELETE FROM sessions WHERE expires_at < now()");
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query<{ id: string; login: string; repos: string[]; expires_at: Date }>(
      "SELECT id, login, repos, expires_at FROM sessions WHERE id = $1 AND expires_at > now()",
      [id],
    );
    const r = rows[0];
    return r ? { id: r.id, login: r.login, repos: r.repos, expiresAt: r.expires_at.getTime() } : undefined;
  }

  async delete(id: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  }
}
