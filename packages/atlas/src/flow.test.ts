import { describe, expect, it } from "vitest";
import { extractFacts } from "./extract.js";
import { buildFlows, diffFlows } from "./flow.js";
import { buildGraph } from "./graph.js";
import type { RequestFlow } from "./types.js";

function flows(files: Record<string, string>): RequestFlow[] {
  return buildFlows(Object.entries(files).map(([p, c]) => extractFacts(p, c)));
}
function flowOf(files: Record<string, string>, label: string): RequestFlow {
  const f = flows(files).find((x) => `${x.method} ${x.path}` === label);
  if (!f) throw new Error(`no flow for ${label}: ${flows(files).map((x) => `${x.method} ${x.path}`).join(", ")}`);
  return f;
}
const titles = (f: RequestFlow) => f.steps.map((s) => `${"  ".repeat(s.depth)}${s.title}`);

const LOGIN_APP = {
  "src/app.ts": `import express from "express";
import authRouter from "./routes/auth";
const app = express();
app.use(express.json());
app.use("/api", authRouter);`,
  "src/routes/auth.ts": `import { Router } from "express";
import * as auth from "../controllers/auth";
const router = Router();
router.post("/login", auth.login);
export default router;`,
  "src/controllers/auth.ts": `import { findUserByEmail } from "../services/users";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
export async function login(req, res) {
  const { email, password } = req.body;
  const user = await findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.hash))) return res.status(401).json({ error: "bad credentials" });
  res.json({ token: jwt.sign({ id: user.id }, process.env.SECRET) });
}`,
  "src/services/users.ts": `import { prisma } from "../db";
export function findUserByEmail(email) {
  return prisma.user.findUnique({ where: { email } });
}`,
  "src/db.ts": `export const prisma = {};`,
};

describe("buildFlows", () => {
  it("tells a login request's story across router, controller and service files", () => {
    const f = flowOf(LOGIN_APP, "POST /api/login");
    expect(titles(f)).toEqual([
      "Client sends POST /api/login",
      "Reads the request body",
      "No rate limiter",
      "Runs login()",
      "Reads email, password from the request body",
      "Input isn't checked",
      "Calls findUserByEmail()",
      "  Looks up user in the database",
      "Checks the password",
      "Rejects with 401 Unauthorized",
      "Creates a login token",
      "Sends back 200 OK",
    ]);
    expect(f.steps.find((s) => s.title === "Runs login()")).toMatchObject({ file: "src/controllers/auth.ts", line: 4 });
    expect(f.steps.find((s) => s.kind === "database")).toMatchObject({ code: "prisma.user.findUnique", file: "src/services/users.ts", depth: 1 });
    expect(f.steps.find((s) => s.kind === "missing" && s.title === "No rate limiter")!.severity).toBe("high");
  });

  it("drops the rate-limit warning once a limiter runs, and the map's findings agree", () => {
    const limited = { ...LOGIN_APP, "src/routes/auth.ts": LOGIN_APP["src/routes/auth.ts"].replace('"/login", auth.login', '"/login", loginLimiter, auth.login') };
    const f = flowOf(limited, "POST /api/login");
    expect(f.steps.map((s) => s.title)).toContain("Rate limiter");
    expect(f.steps.map((s) => s.title)).not.toContain("No rate limiter");

    const graphOf = (files: Record<string, string>) => buildGraph(Object.entries(files).map(([p, c]) => extractFacts(p, c)));
    expect(graphOf(LOGIN_APP).findings.filter((x) => x.kind === "auth-route-no-rate-limit").map((x) => x.title)).toEqual(["POST /api/login has no rate limiting"]);
    expect(graphOf(limited).findings.filter((x) => x.kind === "auth-route-no-rate-limit")).toEqual([]);
  });

  it("spots a sign-up by what it does (hashes a password), not only by its path", () => {
    const files = {
      "src/app.ts": `import bcrypt from "bcrypt";
app.post("/users", async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  await db.user.create({ data: { email: req.body.email, hash } });
  res.status(201).json({ ok: true });
});
app.put("/me", requireAuth, async (req, res) => { await bcrypt.hash(req.body.password, 10); res.sendStatus(204); });`,
    };
    const signup = flowOf(files, "POST /users");
    expect(titles(signup)).toEqual([
      "Client sends POST /users",
      "No rate limiter",
      "Runs the route's code",
      "Reads password, email from the request body",
      "Input isn't checked",
      "Hashes the password",
      "Saves user to the database",
      "Sends back 201 Created",
    ]);
    // Behind a sign-in check, changing your own password isn't the brute-force surface.
    expect(flowOf(files, "PUT /me").steps.map((s) => s.title)).not.toContain("No rate limiter");
    expect(flowOf(files, "PUT /me").steps.map((s) => s.title)).toContain("Sign-in check");
  });

  it("doesn't mistake a fetch result for the HTTP response, and names the service called", () => {
    const f = flowOf(
      {
        "src/app.ts": `async function lookup(fetchImpl, id) {
  const res = await fetchImpl(\`https://api.example.com/items/\${id}\`);
  return res.json();
}
app.get("/items/:id", async (req, res) => { res.json(await lookup(fetch, req.params.id)); });`,
      },
      "GET /items/:id",
    );
    expect(titles(f)).toEqual([
      "Client sends GET /items/:id",
      "Runs the route's code",
      "Reads id from the URL path",
      "Calls lookup()",
      "  Calls api.example.com",
      "Sends back 200 OK",
    ]);
  });

  it("tells a query-builder chain as one database step", () => {
    const f = flowOf(
      {
        "src/app.js": `router.delete("/comments/:id", auth.required, function (req, res, next) {
  Comment.find({ _id: req.params.id }).remove().exec().then(() => res.sendStatus(204));
  User.findById(req.payload.id).populate("following").lean().then((u) => res.json(u));
});`,
      },
      "DELETE /comments/:id",
    );
    expect(f.steps.filter((s) => s.kind === "database").map((s) => `${s.title} [${s.code}]`)).toEqual([
      "Deletes comment from the database [Comment.find.remove]",
      "Looks up user in the database [User.findById]",
    ]);
  });

  it("separates loading a session (lets everyone through) from requiring sign-in", () => {
    const files = {
      "src/app.ts": `app.use(loadSession(store));
app.delete("/posts/:id", async (req, res) => { await Post.deleteOne({ id: req.params.id }); res.sendStatus(204); });
app.delete("/drafts/:id", requireAuth, async (req, res) => { await Draft.deleteOne({ id: req.params.id }); res.sendStatus(204); });`,
    };
    const open = flowOf(files, "DELETE /posts/:id");
    expect(open.steps.map((s) => s.title)).toEqual(expect.arrayContaining(["Loads the session", "No sign-in check found", "Deletes post from the database", "Sends back 204 No Content"]));
    expect(open.steps.find((s) => s.kind === "missing")!.severity).toBe("medium");
    expect(flowOf(files, "DELETE /drafts/:id").steps.some((s) => s.kind === "missing")).toBe(false);
  });

  it("follows Next.js route handlers and session lookups", () => {
    const f = flowOf(
      {
        "app/api/posts/route.ts": `import { auth } from "@/auth";
import { z } from "zod";
const Post = z.object({ title: z.string() });
export async function POST(request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "no" }, { status: 401 });
  const body = Post.parse(await request.json());
  await prisma.post.create({ data: body });
  return NextResponse.json(body, { status: 201 });
}`,
      },
      "POST /api/posts",
    );
    expect(titles(f)).toEqual([
      "Client sends POST /api/posts",
      "Runs POST()",
      "Gets the signed-in user",
      "Rejects with 401 Unauthorized",
      "Reads the request body",
      "Checks the input",
      "Saves post to the database",
      "Sends back 201 Created",
    ]);
  });
});

describe("diffFlows", () => {
  it("shows what a change did to a request, step by step", () => {
    const before = flows(LOGIN_APP);
    const after = flows({
      ...LOGIN_APP,
      "src/routes/auth.ts": LOGIN_APP["src/routes/auth.ts"].replace('"/login", auth.login', '"/login", loginLimiter, auth.login'),
      // Someone "simplified" the login and dropped the password check.
      "src/controllers/auth.ts": LOGIN_APP["src/controllers/auth.ts"].replace(" || !(await bcrypt.compare(password, user.hash))", ""),
    });
    const d = diffFlows(before, after).find((x) => x.label === "POST /api/login")!;
    expect(d.status).toBe("changed");
    expect(d.steps.filter((s) => s.change !== "same").map((s) => `${s.change} ${s.title}`)).toEqual([
      "removed No rate limiter",
      "added Rate limiter",
      "removed Checks the password",
    ]);
    expect(d.summary).toBe("fixed: rate limiter; + rate limiter; − checks the password");
  });

  it("reports new and removed requests, and leaves unchanged ones marked same", () => {
    const before = flows({ "src/app.ts": `app.get("/a", (req, res) => res.json(1));` });
    const after = flows({ "src/app.ts": `app.get("/a", (req, res) => res.json(1)); app.get("/b", (req, res) => res.json(2));` });
    expect(diffFlows(before, after).map((d) => `${d.label}:${d.status}`)).toEqual(["GET /b:added", "GET /a:same"]);
    const login = diffFlows([], flows(LOGIN_APP)).find((d) => d.label === "POST /api/login")!;
    expect(login.summary).toBe("New request path; ⚠ no rate limiter; ⚠ input isn't checked");
    expect(diffFlows(after, before).map((d) => `${d.label}:${d.status}`)).toEqual(["GET /b:removed", "GET /a:same"]);
  });
});
