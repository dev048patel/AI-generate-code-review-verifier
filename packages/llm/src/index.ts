import type { RiskClassification } from "@acrv/core";
import { AnthropicApiTransport, BedrockTransport, ClaudeProvider, type ClaudeProviderOptions } from "./ClaudeProvider.js";
import { MockProvider } from "./MockProvider.js";
import type { LLMProvider } from "./LLMProvider.js";

export * from "./LLMProvider.js";
export * from "./ClaudeProvider.js";
export { MockProvider } from "./MockProvider.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
export const DEFAULT_BEDROCK_MODEL = "anthropic.claude-opus-5";

/**
 * Cost of a classification: the provider's own billed figure when it has
 * one, otherwise an estimate from token counts at Claude Opus 5 list prices
 * (the mock provider reports token *estimates*, not billed tokens).
 */
export function reviewCostUsd(risk: RiskClassification): number {
  return risk.costUsd ?? estimateCostUsd(risk.inputTokens ?? 0, risk.outputTokens ?? 0);
}

/** USD for a token count at the given per-1K-token prices (defaults: Claude Opus 5 list price). */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricePerKInputTokens = 0.005,
  pricePerKOutputTokens = 0.025,
): number {
  return (inputTokens / 1000) * pricePerKInputTokens + (outputTokens / 1000) * pricePerKOutputTokens;
}

export type ProviderName = "anthropic" | "bedrock" | "mock";

export interface CreateLLMProviderOptions {
  provider?: ProviderName;
  modelId?: string;
  awsRegion?: string;
  claude?: ClaudeProviderOptions;
}

/**
 * Picks the LLM provider from explicit config, then LLM_PROVIDER, defaulting
 * to the mock provider so the app runs out of the box without credentials.
 *  - anthropic: Anthropic API (ANTHROPIC_API_KEY or an `ant auth login` profile)
 *  - bedrock:   Amazon Bedrock via the Mantle endpoint (standard AWS credentials, AWS_REGION)
 * ACRV_MODEL_ID overrides the model; ACRV_PRICE_PER_MTOK="in,out" overrides pricing (e.g. Bedrock rates).
 */
export function createLLMProvider(options: CreateLLMProviderOptions = {}, env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const selected = options.provider ?? (env.LLM_PROVIDER as ProviderName | undefined) ?? "mock";
  const pricing = parsePricing(env.ACRV_PRICE_PER_MTOK);
  const claudeOptions: ClaudeProviderOptions = { ...(pricing ? { pricingPerMTok: pricing } : {}), ...options.claude };
  switch (selected) {
    case "anthropic":
      return new ClaudeProvider(
        new AnthropicApiTransport(options.modelId ?? env.ACRV_MODEL_ID ?? DEFAULT_ANTHROPIC_MODEL),
        claudeOptions,
      );
    case "bedrock":
      return new ClaudeProvider(
        new BedrockTransport(options.modelId ?? env.ACRV_MODEL_ID ?? env.BEDROCK_MODEL_ID ?? DEFAULT_BEDROCK_MODEL, {
          awsRegion: options.awsRegion ?? env.AWS_REGION,
        }),
        claudeOptions,
      );
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${selected as string}" (expected anthropic, bedrock, or mock)`);
  }
}

function parsePricing(value: string | undefined): [number, number] | undefined {
  if (!value) return undefined;
  const [i, o] = value.split(",").map(Number);
  return Number.isFinite(i) && Number.isFinite(o) ? [i as number, o as number] : undefined;
}
