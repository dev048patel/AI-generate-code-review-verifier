import { describe, expect, it } from "vitest";
import { diffGraphs, summarizeDiff } from "./diff.js";
import { extractFacts, nextRoutePath } from "./extract.js";
import { buildGraph, stronglyConnected } from "./graph.js";
import { resolveImport } from "./resolve.js";
import type { RepoGraph } from "./types.js";

function graph(files: Record<string, string>, entryFiles: string[] = []): RepoGraph {
  return buildGraph(Object.entries(files).map(([p, c]) => extractFacts(p, c)), { entryFiles });
}

const findings = (g: RepoGraph, kind: string) => g.findings.filter((f) => f.kind === kind);

describe("extractFacts", () => {
  it("captures imports (with local names), exports, routes and middleware", () => {
    const f = extractFacts(
      "src/auth.ts",
      `import express, { Router } from "express";
import type { User } from "./types";
import * as db from "./db";
const legacy = require("./legacy");
export const router = Router();
export default function handler() {}
router.post("/login", loginLimiter, requireBody("email"), async (req, res) => {});
router.get("/me", auth.required, (req, res) => {});
app.use("/api", apiRouter);
const later = () => import("./lazy");`,
    );
    expect(f.imports.map((i) => [i.specifier, i.kind, i.typeOnly])).toEqual([
      ["express", "static", false],
      ["./types", "static", true],
      ["./db", "static", false],
      ["./legacy", "require", false],
      ["./lazy", "dynamic", false],
    ]);
    expect(f.imports[0]!.locals).toEqual(["express", "Router"]);
    expect(f.imports[2]!.locals).toEqual(["db"]);
    expect(f.imports[3]!.locals).toEqual(["legacy"]);
    expect(f.exports.sort()).toEqual(["default", "router"]);
    expect(f.routes).toMatchObject([
      { method: "POST", path: "/login", line: 7, framework: "express-like", middleware: ["loginLimiter", "requireBody"] },
      { method: "GET", path: "/me", line: 8, framework: "express-like", middleware: ["auth.required"] },
    ]);
    expect(f.middlewareUses).toEqual([{ path: "/api", names: ["apiRouter"], line: 9 }]);
  });

  it("reads Fastify-style route options", () => {
    const f = extractFacts("server.ts", `fastify.post("/auth/token", { config: { rateLimit: { max: 5 } } }, handler);`);
    expect(f.routes[0]!.middleware.join(",")).toMatch(/rateLimit/);
  });

  it("maps Next.js file-system routes", () => {
    expect(nextRoutePath("app/api/auth/[...nextauth]/route.ts")).toEqual({ path: "/api/auth/*nextauth", framework: "next-app" });
    expect(nextRoutePath("src/app/(shop)/api/orders/[id]/route.ts")).toEqual({ path: "/api/orders/:id", framework: "next-app" });
    expect(nextRoutePath("pages/api/login.ts")).toEqual({ path: "/api/login", framework: "next-pages" });
    const f = extractFacts("app/api/login/route.ts", "export async function POST(req: Request) {}\nexport function GET() {}");
    expect(f.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /api/login", "POST /api/login"]);
  });

  it("survives syntax it can't fully parse", () => {
    expect(() => extractFacts("broken.ts", "export function (")).not.toThrow();
  });
});

describe("resolveImport", () => {
  const files = new Set(["src/a.ts", "src/lib/index.ts", "src/b.tsx", "src/util.ts"]);
  it("resolves extensions, index files, NodeNext .js specifiers and @/ aliases", () => {
    expect(resolveImport("src/a.ts", "./lib", files)).toEqual({ kind: "module", path: "src/lib/index.ts" });
    expect(resolveImport("src/a.ts", "./b.js", files)).toEqual({ kind: "module", path: "src/b.tsx" });
    expect(resolveImport("src/lib/index.ts", "@/util", files)).toEqual({ kind: "module", path: "src/util.ts" });
    expect(resolveImport("src/a.ts", "@scope/pkg/deep", files)).toEqual({ kind: "package", name: "@scope/pkg" });
    expect(resolveImport("src/a.ts", "node:fs", files)).toEqual({ kind: "ignored" });
    expect(resolveImport("src/a.ts", "./styles.css", files)).toEqual({ kind: "ignored" });
    expect(resolveImport("src/a.ts", "./gone", files)).toEqual({ kind: "missing" });
  });
});

describe("buildGraph findings", () => {
  it("flags a login route with no rate limiting, and not one that has it", () => {
    const g = graph({
      "src/app.ts": `import { router } from "./routes"; app.use(router);`,
      "src/routes.ts": `export const router = Router();
router.post("/login", async (req, res) => {});
router.post("/password/reset", resetLimiter, async (req, res) => {});
router.post("/orders", async (req, res) => {});`,
    });
    expect(findings(g, "auth-route-no-rate-limit").map((f) => f.title)).toEqual(["POST /login has no rate limiting"]);
    expect(g.metrics).toMatchObject({ routes: 3, authRoutes: 2, unprotectedAuthRoutes: 1 });
  });

  it("treats a global or prefix-scoped limiter as covering auth routes", () => {
    const global = graph({ "server.ts": `app.use(rateLimit({ max: 100 })); app.post("/login", h);` });
    expect(findings(global, "auth-route-no-rate-limit")).toHaveLength(0);
    const scoped = graph({ "server.ts": `app.use("/auth", authLimiter); app.post("/auth/login", h); app.post("/signup", h);` });
    expect(findings(scoped, "auth-route-no-rate-limit").map((f) => f.title)).toEqual(["POST /signup has no rate limiting"]);
  });

  it("checks Next.js routes for a rate-limiting library", () => {
    const bad = graph({ "app/api/login/route.ts": "export async function POST() {}" });
    const good = graph({ "app/api/login/route.ts": `import { Ratelimit } from "@upstash/ratelimit";\nexport async function POST() {}` });
    expect(findings(bad, "auth-route-no-rate-limit")).toHaveLength(1);
    expect(findings(good, "auth-route-no-rate-limit")).toHaveLength(0);
  });

  it("resolves router mount prefixes through imports, inline requires and composed local routers", () => {
    const g = graph({
      "src/main.ts": `import api from "./api"; app.use("/v1", api);`,
      "src/api.ts": `import users from "./users"; const api = Router().use(users); export default Router().use("/api", api);`,
      "src/users.ts": `const router = Router(); router.post("/users/login", h); export default router;`,
      "legacy/index.js": `router.use("/old", require("./profiles"));`,
      "legacy/profiles.js": `router.get("/:name", h); module.exports = router;`,
    });
    const routes = g.nodes.filter((n) => n.kind === "route").map((n) => n.label).sort();
    expect(routes).toEqual(["GET /old/:name", "POST /v1/api/users/login"]);
  });

  it("detects broken imports and references to exports that no longer exist", () => {
    const g = graph({
      "src/a.ts": `import { add, subtract } from "./math"; import x from "./missing";`,
      "src/math.ts": `export function add() {}`,
    });
    expect(findings(g, "broken-import").map((f) => f.title)).toEqual(['Import "./missing" does not resolve']);
    expect(findings(g, "broken-reference").map((f) => f.title)).toEqual(["`subtract` is not exported by src/math.ts"]);
    expect(g.edges.find((e) => e.from === "m:src/a.ts" && e.to === "m:src/math.ts")?.broken).toBe(true);
  });

  it("does not flag named imports from CommonJS or `export *` modules", () => {
    const g = graph({
      "a.ts": `import { anything } from "./cjs"; import { re } from "./barrel";`,
      "cjs.js": `module.exports = { anything: 1 };`,
      "barrel.ts": `export * from "./impl";`,
      "impl.ts": `export const re = 1;`,
    });
    expect(findings(g, "broken-reference")).toHaveLength(0);
  });

  it("finds import cycles, ignoring type-only imports", () => {
    const g = graph({
      "a.ts": `import { b } from "./b"; export const a = 1;`,
      "b.ts": `import { a } from "./a"; export const b = 1;`,
      "c.ts": `import type { d } from "./d"; export const c = 1;`,
      "d.ts": `import { c } from "./c"; export type d = number;`,
    });
    const cycles = findings(g, "import-cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.detail).toMatch(/^a\.ts → b\.ts\./);
  });

  it("reports modules nothing imports, except entry points, tests and package.json targets", () => {
    const g = graph(
      {
        "src/index.ts": `import "./used";`,
        "src/used.ts": "export const u = 1;",
        "src/orphan.ts": "export const o = 1;",
        "src/seed.ts": "console.log(1);",
        "src/orphan.test.ts": "",
        "vite.config.ts": "",
      },
      ["src/seed.ts"],
    );
    expect(findings(g, "unused-module").map((f) => f.file)).toEqual(["src/orphan.ts"]);
  });

  it("treats export-less scripts and test fixtures as entry points, not dead code", () => {
    const g = graph({
      "tools/build.mjs": `import { build } from "esbuild"; await build({});`,
      "ext/src/content.ts": `document.body.append("x");`,
      "src/setupTests.ts": `import "@testing-library/jest-dom";`,
      "eval/fixtures/case-1/after/stats.ts": "export const mean = () => 0;",
      "src/options.ts": "export const defaults = {};",
    });
    expect(findings(g, "unused-module").map((f) => f.file)).toEqual(["src/options.ts"]);
  });

  it("does not ask for rate limiting on logout routes", () => {
    const g = graph({
      "src/app.ts": `app.post("/api/auth/logout", h); app.post("/signout", h); app.post("/api/auth/login", h);`,
    });
    expect(findings(g, "auth-route-no-rate-limit").map((f) => f.title)).toEqual(["POST /api/auth/login has no rate limiting"]);
  });
});

describe("stronglyConnected", () => {
  it("handles long chains without recursion limits", () => {
    const g = new Map<string, Set<string>>();
    for (let i = 0; i < 20_000; i++) g.set(`n${i}`, new Set([`n${i + 1}`]));
    g.set("n20000", new Set(["n0"]));
    expect(stronglyConnected(g).filter((c) => c.length > 1)[0]).toHaveLength(20_001);
  });
});

describe("diffGraphs", () => {
  const before = graph({
    "src/app.ts": `import { h } from "./handlers"; app.use(rateLimit()); app.post("/login", h); app.get("/users/:id", h); app.get("/health", h);`,
    "src/handlers.ts": "export const h = 1; export const helper = 2;",
    "src/other.ts": `import { helper } from "./handlers"; export const o = 1;`,
  });

  it("reports what a change broke, removed and fixed", () => {
    const after = graph({
      // Rate limiting removed, /health removed, /users/:id param renamed, helper export deleted.
      "src/app.ts": `import { h } from "./handlers"; app.post("/login", h); app.get("/users/:userId", h);`,
      "src/handlers.ts": "export const h = 1;",
      "src/other.ts": `import { helper } from "./handlers"; export const o = 1;`,
    });
    const d = diffGraphs(before, after);
    const kinds = d.newFindings.map((f) => `${f.kind}: ${f.title}`).sort();
    expect(kinds).toEqual([
      "auth-route-no-rate-limit: POST /login has no rate limiting",
      "broken-reference: `helper` is not exported by src/handlers.ts",
      "route-removed: GET /health was removed",
    ]);
    // A renamed path parameter is the same endpoint.
    expect(d.removedNodes.filter((n) => n.kind === "route").map((n) => n.label)).toEqual(["GET /health"]);
    expect(d.metricsDelta.routes).toBe(-1);
    expect(summarizeDiff(d)).toMatch(/1 route\(s\) removed.*3 new high-severity|0 route\(s\) added, 1 removed/);
  });

  it("treats a remounted route as moved, not removed", () => {
    const after = graph({
      "src/app.ts": `import { h } from "./handlers"; app.use(rateLimit()); app.post("/v2/login", h); app.get("/v2/users/:id", h); app.get("/v2/health", h);`,
      "src/handlers.ts": "export const h = 1; export const helper = 2;",
      "src/other.ts": `import { helper } from "./handlers"; export const o = 1;`,
    });
    expect(diffGraphs(before, after).newFindings.filter((f) => f.kind === "route-removed")).toEqual([]);
  });
});
