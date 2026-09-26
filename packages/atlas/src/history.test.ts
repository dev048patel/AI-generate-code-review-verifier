import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffGraphs } from "./diff.js";
import { analyzeHistory, entryFilesFromPackageJson, graphAtRef, graphOfWorktree } from "./history.js";
import { compareRuntime, RuntimeAggregator, type OtlpTraces } from "./runtime.js";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}

async function commit(files: Record<string, string | null>, subject: string): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(repo, file);
    if (content === null) await rm(abs, { force: true });
    else {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }
  }
  git("add", "-A");
  git("commit", "-qm", subject);
  return git("rev-parse", "HEAD");
}

const LIMITED_APP = `import rateLimit from "express-rate-limit";
import { login } from "./auth";
app.use(rateLimit({ max: 100 }));
app.post("/login", login);
`;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "acrv-atlas-"));
  git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("analyzeHistory", () => {
  it("replays commits and pins each regression to the commit that caused it", async () => {
    await commit({ "package.json": JSON.stringify({ main: "src/app.ts" }), "src/app.ts": LIMITED_APP, "src/auth.ts": "export const login = () => {};\n" }, "init");
    await commit({ "src/util.ts": "export const helper = (x: number) => x * 2;\nexport const other = 1;\n" }, "add util");
    const bad = await commit({ "src/app.ts": LIMITED_APP.replace("app.use(rateLimit({ max: 100 }));\n", "") }, "drop limiter");
    await commit({ "src/auth.ts": null }, "delete auth");

    const a = await analyzeHistory(repo);
    expect(a.commits.map((c) => c.subject)).toEqual(["init", "add util", "drop limiter", "delete auth"]);
    const dropped = a.commits.find((c) => c.sha === bad)!;
    expect(dropped.delta.newFindings).toEqual(["auth-route-no-rate-limit:POST /login"]);
    expect(a.commits[3]!.delta.newFindings).toEqual(["broken-import:src/app.ts:./auth"]);
    expect(a.commits[3]!.delta.modulesRemoved).toBe(1);
    expect(a.commits.map((c) => c.metrics.modules)).toEqual([2, 3, 3, 2]);

    const recs = a.recommendations.map((r) => r.title);
    expect(recs[0]).toBe("Add rate limiting to POST /login");
    expect(a.recommendations[0]!.commit).toBe(bad);
    expect(recs).toContain("Fix 1 broken import(s)");
  });

  it("counts code thrown away within a few commits as waste", async () => {
    await commit({ "src/a.ts": "export const keep = 1;\n" }, "init");
    const generated = Array.from({ length: 40 }, (_, i) => `export const generated${i} = computeSomething(${i});`).join("\n");
    await commit({ "src/a.ts": `export const keep = 1;\n${generated}\n` }, "generate");
    await commit({ "src/a.ts": "export const keep = 1;\nexport const rewritten = 2;\n" }, "rewrite");
    const a = await analyzeHistory(repo);
    expect(a.waste.shortLivedLines).toBe(40);
    expect(a.waste.addedLines).toBe(41);
    expect(a.waste.estimatedTokens).toBeGreaterThan(300);
    expect(a.recommendations.some((r) => r.id === "rec:waste")).toBe(false); // below the 200-line floor
    expect(a.commits[2]!.shortLivedLines).toBe(40);
  });
});

describe("graphAtRef / graphOfWorktree", () => {
  it("previews uncommitted work against a commit, before any PR exists", async () => {
    const base = await commit({ "src/app.ts": LIMITED_APP, "src/auth.ts": "export const login = () => {};\n" }, "init");
    await writeFile(path.join(repo, "src/app.ts"), LIMITED_APP.replace("app.use(rateLimit({ max: 100 }));\n", "") + 'app.post("/signup", login);\n');
    await writeFile(path.join(repo, "src/new.ts"), "export const brandNew = 1;\n"); // untracked
    const d = diffGraphs(await graphAtRef(repo, base), await graphOfWorktree(repo));
    expect(d.addedNodes.map((n) => n.id).sort()).toEqual(["m:src/new.ts", "r:POST /signup"]);
    expect(d.newFindings.map((f) => f.id).sort()).toEqual([
      "auth-route-no-rate-limit:POST /login",
      "auth-route-no-rate-limit:POST /signup",
      "unused-module:src/new.ts",
    ]);
  });

  it("never follows symlinks out of the working tree", async () => {
    await commit({ "src/a.ts": "export const a = 1;\n" }, "init");
    const outside = await mkdtemp(path.join(os.tmpdir(), "acrv-outside-"));
    await writeFile(path.join(outside, "secret.ts"), 'app.post("/login", h); // SECRET');
    await symlink(path.join(outside, "secret.ts"), path.join(repo, "src/leak.ts"));
    const g = await graphOfWorktree(repo);
    expect(g.nodes.some((n) => n.id === "m:src/leak.ts")).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  it("finds entry points referenced from package.json scripts and config", () => {
    expect(
      entryFilesFromPackageJson(
        JSON.stringify({ main: "./dist/index.js", bin: { x: "bin/cli.mjs" }, scripts: { seed: "ts-node --transpile-only src/prisma/seed.ts" }, prisma: { seed: "tsx prisma/seed.ts" } }),
      ).sort(),
    ).toEqual(["bin/cli.mjs", "dist/index.js", "prisma/seed.ts", "src/prisma/seed.ts"]);
  });
});

describe("runtime traces", () => {
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const span = (id: string, parent: string | undefined, kind: number, start: number, end: number, attrs: Record<string, string>, error = false) => ({
    traceId: "t",
    spanId: id,
    parentSpanId: parent,
    name: id,
    kind,
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(end),
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })),
    status: { code: error ? 2 : 1 },
  });
  const payload: OtlpTraces = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
        scopeSpans: [
          {
            spans: [
              span("s1", undefined, 2, 0, 120, { "http.request.method": "POST", "http.route": "/login/:provider" }),
              span("s2", "s1", 3, 10, 90, { "db.system": "postgresql" }),
              span("s3", "s1", 3, 95, 115, { "url.full": "https://api.stripe.com/v1/charges" }, true),
              span("s4", undefined, 2, 200, 205, { "http.request.method": "GET", "http.route": "/metrics-only-at-runtime" }),
            ],
          },
        ],
      },
    ],
  };

  it("builds a call graph with latency and errors, keyed like the static map", () => {
    const agg = new RuntimeAggregator();
    expect(agg.ingest(payload)).toBe(4);
    const snap = agg.snapshot();
    expect(snap.edges.map((e) => `${e.from} -> ${e.to} ${e.p50Ms}ms err=${e.errors}`).sort()).toEqual([
      "r:POST /login/:* -> db:postgresql 80ms err=0",
      "r:POST /login/:* -> ext:api.stripe.com 20ms err=1",
    ]);
  });

  it("shows which declared routes never ran and which runtime routes the code map doesn't know", async () => {
    await commit({ "src/app.ts": `app.post("/login/:id", h); app.get("/orders", h);` }, "init");
    const agg = new RuntimeAggregator();
    agg.ingest(payload);
    const cov = compareRuntime(await graphAtRef(repo, "HEAD"), agg.snapshot());
    expect(cov.neverCalled).toEqual(["GET /orders"]);
    expect(cov.unknownAtRuntime).toEqual(["GET /metrics-only-at-runtime"]);
    expect(cov.failing[0]!.to).toBe("ext:api.stripe.com");
  });
});
