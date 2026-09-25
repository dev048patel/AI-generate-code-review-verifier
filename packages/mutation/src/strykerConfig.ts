export interface StrykerConfigOptions {
  mutateGlobs: string[];
  testGlobs: string[];
  reportFileName: string;
}

/**
 * Builds a minimal Stryker configuration scoped to exactly the files touched
 * by one PR review, using the vitest test runner so generated tests execute
 * with the same runner as the rest of this repo. Thresholds are disabled so
 * a low mutation score doesn't turn into a non-zero Stryker exit code -- we
 * want the *number*, not a pass/fail gate, since a low score on
 * AI-generated code is exactly the signal this tool exists to surface.
 */
export function buildStrykerConfig(options: StrykerConfigOptions): Record<string, unknown> {
  return {
    $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    packageManager: "npm",
    testRunner: "vitest",
    mutate: options.mutateGlobs,
    reporters: ["json"],
    jsonReporter: { fileName: options.reportFileName },
    coverageAnalysis: "perTest",
    concurrency: 2,
    timeoutMS: 10000,
    thresholds: { high: 0, low: 0, break: null },
    disableTypeChecks: "**/*.{js,ts,jsx,tsx}",
    ignoreStatic: true,
    vitest: {
      related: false,
      configFile: "vitest.config.mjs",
    },
  };
}
