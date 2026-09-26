import { describe, expect, it } from "vitest";
import { buildArchitecture, diffArchitecture } from "./architecture.js";
import { extractFacts } from "./extract.js";
import { buildFlows } from "./flow.js";

function arch(files: Record<string, string>) {
  return buildArchitecture(buildFlows(Object.entries(files).map(([p, c]) => extractFacts(p, c))));
}

const APP = {
  "src/app.ts": `import express from "express";
import cors from "cors";
import routes from "./routes";
const app = express();
app.use(cors());
app.use(express.json());
app.use(routes);
app.use(errorHandler);`,
  "src/routes.ts": `import { Router } from "express";
import * as auth from "./auth/auth.controller";
import * as posts from "./posts/posts.controller";
const router = Router();
router.post("/login", auth.login);
router.get("/posts", requireAuth, posts.list);
export default router;`,
  "src/auth/auth.controller.ts": `import { login as doLogin } from "./auth.service";
export async function login(req, res) { res.json(await doLogin(req.body.email, req.body.password)); }`,
  "src/auth/auth.service.ts": `import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../db";
export async function login(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.hash))) throw new HttpError(401, "bad credentials");
  return { token: jwt.sign({ id: user.id }, "s") };
}`,
  "src/posts/posts.controller.ts": `import { prisma } from "../db";
export async function list(req, res) {
  const r = await fetch("https://api.example.com/flags");
  res.json(await prisma.post.findMany());
}`,
  "src/db.ts": `export const prisma = {};`,
};

describe("buildArchitecture", () => {
  it("lays the app out as zones of real parts, each tied to its code", () => {
    const a = arch(APP);
    const byId = new Map(a.components.map((c) => [c.id, c]));
    expect(a.components.map((c) => `${c.zone}/${c.type}: ${c.label}`).sort()).toEqual([
      "checks/gap: No rate limiter",
      "checks/security: Sign-in check",
      "clients/client: Clients",
      "data/database: Database",
      "data/external: api.example.com",
      "data/security: Login tokens",
      "data/security: Password hashing",
      "middleware/middleware: Middleware",
      "routes/backend: Auth controller",
      "routes/backend: Posts controller",
      "services/service: Auth service",
    ]);
    expect(byId.get("mw:pipeline")!.sublabel).toBe("CORS · body parser");
    expect(byId.get("db:main")!.sublabel).toBe("user · post");
    expect(byId.get("gap:rate-limit")!.tag).toBe("missing");
    expect(byId.get("code:src/auth/auth.controller.ts")!.sources[0]).toMatchObject({ file: "src/auth/auth.controller.ts", line: 2 });
    // The error handler is registered after the routes, so it isn't a step before them.
    expect(byId.get("mw:pipeline")!.sublabel).not.toMatch(/error/i);
  });

  it("labels what travels along each arrow, and only login passes through the gap", () => {
    const a = arch(APP);
    const edge = (from: string, to: string) => a.edges.find((e) => e.from === from && e.to === to);
    expect(edge("mw:pipeline", "gap:rate-limit")!.labels).toEqual(["POST /login"]);
    expect(edge("mw:pipeline", "mw:sign-in-check")!.labels).toEqual(["GET /posts"]);
    expect(edge("code:src/auth/auth.service.ts", "db:main")!.labels).toEqual(["read user"]);
    expect(edge("code:src/auth/auth.service.ts", "sec:passwords")!.labels).toEqual(["bcrypt.compare"]);
    expect(edge("code:src/posts/posts.controller.ts", "ext:api-example-com")!.labels).toEqual(["fetch"]);
  });

  it("tells each request as a story of hops, worst gap first", () => {
    const a = arch(APP);
    expect(a.stories.map((s) => `${s.label} · ${s.title}`)).toEqual(["POST /login · Logs a user in: no rate limiter", "GET /posts · Calls another service"]);
    expect(a.stories[0]!.severity).toBe("high");
    expect(a.stories[0]!.hops.map((h) => `${h.kind} ${h.from} → ${h.to}: ${h.label}`)).toEqual([
      "request client → mw:pipeline: POST /login",
      "gap mw:pipeline → gap:rate-limit: POST /login",
      "request gap:rate-limit → code:src/auth/auth.controller.ts: POST /login",
      "call code:src/auth/auth.controller.ts → code:src/auth/auth.service.ts: login()",
      "data code:src/auth/auth.service.ts → db:main: read user",
      "call code:src/auth/auth.service.ts → sec:passwords: bcrypt.compare",
      "return code:src/auth/auth.service.ts → client: HttpError (401)",
      "call code:src/auth/auth.service.ts → sec:tokens: jwt.sign",
      "return code:src/auth/auth.controller.ts → client: 200 OK",
    ]);
    expect(a.stories[0]!.hops[1]!.note).toMatch(/^⚠ No rate limiter: /);
  });
});

describe("buildArchitecture detail level", () => {
  it("folds helpers a service calls into that service", () => {
    const a = arch({
      "src/app.ts": `import { list } from "./posts.service";
app.get("/posts", async (req, res) => res.json(await list()));`,
      "src/posts.service.ts": `import { toDto } from "./posts.mapper";
export async function list() { return (await prisma.post.findMany()).map((p) => toDto(p)); }`,
      "src/posts.mapper.ts": `import { sign } from "./signer";
export function toDto(p) { return { ...p, sig: sign(p) }; }`,
      "src/signer.ts": `import jwt from "jsonwebtoken";
export function sign(p) { return jwt.sign(p, "k"); }`,
    });
    expect(a.components.map((c) => c.label).sort()).toEqual(["App", "Clients", "Database", "Login tokens", "Posts service"]);
    // The token work done deep inside the mapper is drawn as the service's own.
    expect(a.edges.find((e) => e.to === "sec:tokens")!.from).toBe("code:src/posts.service.ts");
    expect(a.components.find((c) => c.label === "Posts service")!.sources.map((s) => s.label)).toEqual(["list()", "toDto()", "sign()"]);
  });
});

describe("diffArchitecture", () => {
  it("shows parts and connections a change adds or removes", () => {
    const before = arch(APP);
    const after = arch({
      ...APP,
      "src/routes.ts": APP["src/routes.ts"].replace('"/login", auth.login', '"/login", loginLimiter, auth.login'),
      "src/posts/posts.controller.ts": APP["src/posts/posts.controller.ts"].replace('  const r = await fetch("https://api.example.com/flags");\n', ""),
    });
    const d = diffArchitecture(before, after);
    const status = (id: string) => d.components.find((c) => c.id === id)?.status;
    expect(status("mw:rate-limiter")).toBe("added");
    expect(status("gap:rate-limit")).toBe("removed");
    expect(status("ext:api-example-com")).toBe("removed");
    expect(status("db:main")).toBe("same");
    expect(d.edges.find((e) => e.from === "mw:pipeline" && e.to === "mw:rate-limiter")?.status).toBe("added");
    expect(d.summary).toEqual(["fixed: no rate limiter", "+ Rate limiter", "− api.example.com"]);
  });
});
