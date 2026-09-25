import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./verifyWebhookSignature.js";

function sign(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed payload", () => {
    const payload = JSON.stringify({ hello: "world" });
    const secret = "test-secret";
    expect(verifyWebhookSignature(payload, sign(payload, secret), secret)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const payload = JSON.stringify({ hello: "world" });
    expect(verifyWebhookSignature(payload, sign(payload, "wrong-secret"), "test-secret")).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const secret = "test-secret";
    const signature = sign(JSON.stringify({ hello: "world" }), secret);
    expect(verifyWebhookSignature(JSON.stringify({ hello: "tampered" }), signature, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature("{}", undefined, "secret")).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifyWebhookSignature("{}", "not-a-real-signature", "secret")).toBe(false);
  });
});
