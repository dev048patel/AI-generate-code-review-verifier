import { describe, expect, it, vi } from "vitest";
import { RetryExhaustedError, withRetry } from "./retry.js";

describe("withRetry", () => {
  it("returns the result on the first successful attempt without retrying", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(op, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: async () => {} });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(op, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep: async () => {},
      random: () => 0.5,
    });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("throws RetryExhaustedError after maxAttempts failures", async () => {
    const op = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      withRetry(op, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: async () => {} }),
    ).rejects.toThrow(RetryExhaustedError);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("caps delay growth at maxDelayMs and applies jitter between 0 and the capped delay", async () => {
    const delays: number[] = [];
    const op = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(op, {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 250,
        random: () => 1, // full jitter at its max: delay === capped delay
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toThrow();
    // Uncapped exponential would be 100, 200, 400 -- the third is capped to 250.
    expect(delays).toEqual([100, 200, 250]);
  });
});
