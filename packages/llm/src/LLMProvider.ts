import type { ChangedFunction, DiffFile, RiskClassification } from "@acrv/core";

export interface RiskClassificationRequest {
  repo: string;
  prTitle: string;
  prDescription: string;
  files: DiffFile[];
  changedFunctions: ChangedFunction[];
}

/**
 * Abstraction over "an LLM that reads a diff and returns intent + risk
 * findings". Two implementations exist: `ClaudeProvider` (Claude via the
 * Anthropic API or Amazon Bedrock) and `MockProvider` (deterministic
 * heuristic engine used for local development, unit tests, and the
 * evaluation harness when no credentials are configured).
 */
export interface LLMProvider {
  readonly name: string;
  classify(request: RiskClassificationRequest): Promise<RiskClassification>;
}
