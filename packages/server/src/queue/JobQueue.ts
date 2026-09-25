export interface QueuedJobInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  installationId?: number;
}

export interface QueuedJob extends QueuedJobInput {
  id: number;
  status: "queued" | "running" | "done" | "failed" | "superseded";
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueResult {
  enqueued: boolean;
  reason?: "duplicate-delivery" | "duplicate-commit";
  job?: QueuedJob;
}

/**
 * Durable review queue semantics shared by the in-memory (dev/tests) and
 * Postgres (production) implementations:
 *  - idempotent: one job per (repo, PR, head commit); a redelivered webhook
 *    (same X-GitHub-Delivery) is dropped before it reaches the queue;
 *  - supersede: a new head commit cancels still-queued jobs for older ones,
 *    and a running job checks `isSuperseded` before publishing;
 *  - retries with backoff, then a dead-letter state ("failed") for inspection;
 *  - crash recovery: a job whose worker stopped heartbeating is requeued.
 */
export interface JobQueue {
  enqueue(job: QueuedJobInput, deliveryId?: string): Promise<EnqueueResult>;
  claim(workerId: string): Promise<QueuedJob | null>;
  /** Called periodically by the worker holding the job, so long reviews aren't mistaken for crashed ones. */
  heartbeat(id: number): Promise<void>;
  complete(id: number, reviewId?: string): Promise<void>;
  fail(id: number, error: unknown): Promise<void>;
  isSuperseded(job: QueuedJob): Promise<boolean>;
  listFailed(limit?: number): Promise<QueuedJob[]>;
  /** Requeue (or dead-letter) jobs stuck in "running" longer than `staleAfterMs`. Returns how many were touched. */
  recoverStale(staleAfterMs: number): Promise<number>;
}

export const MAX_ATTEMPTS = 3;

/** Exponential backoff with full jitter: attempt 1 -> up to 30s, 2 -> 60s, ... capped at 10 min. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(600_000, 30_000 * 2 ** (attempts - 1)));
}

export class InMemoryJobQueue implements JobQueue {
  private jobs: QueuedJob[] = [];
  private runAfter = new Map<number, number>();
  private lockedAt = new Map<number, number>();
  private deliveries = new Set<string>();
  private nextId = 1;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly retryDelay: (attempts: number) => number = retryDelayMs,
  ) {}

  async enqueue(input: QueuedJobInput, deliveryId?: string): Promise<EnqueueResult> {
    if (deliveryId) {
      if (this.deliveries.has(deliveryId)) return { enqueued: false, reason: "duplicate-delivery" };
      this.deliveries.add(deliveryId);
    }
    const samePr = (j: QueuedJob) => j.owner === input.owner && j.repo === input.repo && j.prNumber === input.prNumber;
    const existing = this.jobs.find((j) => samePr(j) && j.headSha === input.headSha);
    if (existing) return { enqueued: false, reason: "duplicate-commit", job: existing };

    for (const j of this.jobs) {
      if (samePr(j) && j.status === "queued") this.touch(j, { status: "superseded" });
    }
    const ts = new Date(this.now()).toISOString();
    const job: QueuedJob = { ...input, id: this.nextId++, status: "queued", attempts: 0, createdAt: ts, updatedAt: ts };
    this.jobs.push(job);
    return { enqueued: true, job };
  }

  async claim(_workerId: string): Promise<QueuedJob | null> {
    const job = this.jobs.find((j) => j.status === "queued" && (this.runAfter.get(j.id) ?? 0) <= this.now());
    if (!job) return null;
    this.touch(job, { status: "running", attempts: job.attempts + 1 });
    this.lockedAt.set(job.id, this.now());
    return { ...job };
  }

  async heartbeat(id: number): Promise<void> {
    if (this.byId(id)?.status === "running") this.lockedAt.set(id, this.now());
  }

  async complete(id: number): Promise<void> {
    const job = this.byId(id);
    if (job && job.status === "running") this.touch(job, { status: "done" });
  }

  async fail(id: number, error: unknown): Promise<void> {
    const job = this.byId(id);
    if (!job) return;
    const lastError = String(error).slice(0, 2000);
    if (job.attempts >= MAX_ATTEMPTS) {
      this.touch(job, { status: "failed", lastError });
    } else {
      this.touch(job, { status: "queued", lastError });
      this.runAfter.set(id, this.now() + this.retryDelay(job.attempts));
    }
  }

  async isSuperseded(job: QueuedJob): Promise<boolean> {
    return this.jobs.some(
      (j) => j.owner === job.owner && j.repo === job.repo && j.prNumber === job.prNumber && j.id > job.id && j.status !== "superseded",
    );
  }

  async listFailed(limit = 50): Promise<QueuedJob[]> {
    return this.jobs.filter((j) => j.status === "failed").slice(-limit).reverse().map((j) => ({ ...j }));
  }

  async recoverStale(staleAfterMs: number): Promise<number> {
    let n = 0;
    for (const j of this.jobs) {
      if (j.status !== "running" || this.now() - (this.lockedAt.get(j.id) ?? 0) < staleAfterMs) continue;
      n++;
      await this.fail(j.id, "worker stopped responding (stale lock)");
    }
    return n;
  }

  /** For tests and the local ops view. */
  all(): QueuedJob[] {
    return this.jobs.map((j) => ({ ...j }));
  }

  private byId(id: number): QueuedJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private touch(job: QueuedJob, patch: Partial<QueuedJob>): void {
    Object.assign(job, patch, { updatedAt: new Date(this.now()).toISOString() });
  }
}
