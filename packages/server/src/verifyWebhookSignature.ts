import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies a GitHub webhook's `X-Hub-Signature-256` header against the shared webhook secret. */
export function verifyWebhookSignature(payloadRaw: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(payloadRaw).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf-8");
  const actualBuf = Buffer.from(signatureHeader, "utf-8");

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
