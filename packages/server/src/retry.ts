export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RetryExhaustedError extends Error {
  constructor(public readonly attempts: number, public readonly lastError: unknown) {
    super(`Retry exhausted after ${attempts} attempt(s): ${String(lastError)}`);
  }
}

/**
 * Retries an idempotent operation with capped exponential backoff and full
 * jitter, following the Amazon Builders' Library guidance the project brief
 * calls out: retry at one layer, only for idempotent operations (Bedrock
 * classification calls and GitHub API reads/writes are both safe to retry
 * here -- posting the same review comment twice is avoided by the caller
 * upserting on review id, not by this utility).
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, random = Math.random, sleep = defaultSleep } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const cappedDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = random() * cappedDelay; // full jitter, per the Builders' Library
      await sleep(jittered);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
