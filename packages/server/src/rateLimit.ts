import type { NextFunction, Request, Response } from "express";

/**
 * Token bucket per key (signed-in user, else client IP). In-process: with
 * several web replicas each enforces its own bucket, so the effective limit
 * is replicas x capacity -- fine for protecting spend on expensive endpoints,
 * which the per-account LLM budget backstops anyway.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.updated) / 60_000) * this.refillPerMinute);
    b.updated = t;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.buckets.clear(); // bound memory under abuse
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  middleware(keyOf: (req: Request) => string) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.take(keyOf(req))) return next();
      res.status(429).json({ error: "Too many requests -- try again in a minute." });
    };
  }
}
