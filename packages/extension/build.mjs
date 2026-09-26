// Bundles the extension into dist/ (load it via chrome://extensions -> "Load unpacked").
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: { content: "src/content.ts", background: "src/background.ts", options: "src/options.ts" },
  bundle: true,
  format: "esm",
  target: "chrome114",
  outdir: "dist",
  logLevel: "info",
});
await cp("static", "dist", { recursive: true });
console.log("Built dist/ — load it at chrome://extensions (Developer mode → Load unpacked).");
