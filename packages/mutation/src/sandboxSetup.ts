import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a vitest config scoped to the sandbox directory. Required because
 * without an explicit configFile, Vite walks up parent directories and would
 * otherwise pick up this monorepo's root vitest.config.ts (whose `include`
 * pattern doesn't match sandbox paths), causing "no tests found".
 */
export async function writeSandboxVitestConfig(sandboxDir: string, testGlobs: string[]): Promise<string> {
  await mkdir(sandboxDir, { recursive: true });
  const fileName = "vitest.config.mjs";
  const content = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ${JSON.stringify(testGlobs)},
    globals: false,
    environment: "node",
  },
});
`;
  await writeFile(path.join(sandboxDir, fileName), content, "utf-8");
  return fileName;
}
