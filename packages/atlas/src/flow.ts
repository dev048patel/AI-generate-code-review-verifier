import { importsRateLimiter, isAuthRoute, joinPaths, RATE_LIMIT_RE, resolveImport, routeId, routeMounts } from "./resolve.js";
import { DB_VERBS } from "./calls.js";
import type { FileFacts, FlowCall, FlowDiff, FlowStep, FlowStepChange, FunctionFacts, RequestFlow, RouteFact } from "./types.js";

/**
 * Request flows: the life of one HTTP request told as numbered steps, e.g.
 *
 *   1. Client sends POST /api/users/login
 *   2. ⚠ No rate limiter
 *   3. Runs login() in src/controllers/auth.ts
 *   4. Reads email, password from the request body
 *   5. Looks up user in the database          prisma.user.findUnique
 *   6. Checks the password                    bcrypt.compare
 *   7. Rejects with 401 Unauthorized
 *   8. Creates a login token                  jwt.sign
 *   9. Sends back 200 OK
 *
 * Built from the same syntax-only facts as the map: middleware from the route
 * and every router it's mounted under, then the handler's calls, following
 * calls into the repo's own functions a few levels deep.
 */

const MAX_DEPTH = 3;
const MAX_STEPS = 80;

const AUTH_MIDDLEWARE = /auth|authenticat|requireUser|requireLogin|isLoggedIn|loggedIn|protect|verifyToken|verifyJwt|jwt|passport|session|guard|ensureUser|currentUser|clerk|signedIn/i;
/** Works out who the caller is but lets everyone through: not a gate. */
const SESSION_LOADER = /^(load|parse|attach|populate|init|use|with|express)\w*(session|user|auth)|^session$|^(cookieSession|expressSession)$/i;
const PUBLIC_PATH = /webhook|health|status|ping|public|contact|subscribe|newsletter|callback|metrics|\/v1\/traces/i;
const SIGN_IN_PROOF = /verify|getServerSession|getSession|^auth$|currentUser|requireUser|requireAuth|getAuth|verifySession|validateRequest|getCurrentUser|requireSession|passport/i;

interface Resolved {
  file: FileFacts;
  fn: FunctionFacts;
}

function describeMiddleware(name: string): { title: string; explain: string } {
  if (RATE_LIMIT_RE.test(name)) return { title: "Rate limiter", explain: "Stops one caller from sending too many requests in a short time (for example, guessing passwords)." };
  if (SESSION_LOADER.test(name)) return { title: "Loads the session", explain: "Works out who the caller is from their cookie or token. It doesn't turn anyone away by itself." };
  if (/origin/i.test(name)) return { title: "Same-origin check", explain: "Rejects requests sent from other websites, so a page elsewhere can't act as a signed-in user." };
  if (/csrf|csurf/i.test(name)) return { title: "CSRF check", explain: "Makes sure the request came from your own site, not a page tricking a signed-in user." };
  if (/admin|role|permission|authoriz|isOwner|canAccess/i.test(name)) return { title: "Permission check", explain: "Lets the request through only if the caller is allowed to do this." };
  if (AUTH_MIDDLEWARE.test(name)) return { title: "Sign-in check", explain: "Lets the request through only if the caller is signed in; otherwise it's turned away here." };
  if (/valid|schema|celebrate|zod|joi|yup/i.test(name)) return { title: "Checks the input", explain: "Rejects the request early if the data sent has the wrong shape." };
  if (/json|bodyParser|urlencoded|multer|upload|raw|text/i.test(name)) return { title: "Reads the request body", explain: "Turns the raw request into data the code can use (JSON, form fields or files)." };
  if (/cookie/i.test(name)) return { title: "Reads cookies", explain: "Makes the browser's cookies available to the code." };
  if (/cors/i.test(name)) return { title: "CORS", explain: "Decides which other websites may call this API from a browser." };
  if (/helmet/i.test(name)) return { title: "Security headers", explain: "Adds HTTP headers that make common browser attacks harder." };
  if (/morgan|log|pino|winston/i.test(name)) return { title: "Logs the request", explain: "Writes a line to the logs for this request." };
  if (/compress/i.test(name)) return { title: "Compresses the response", explain: "Shrinks the response so it downloads faster." };
  if (/static/i.test(name)) return { title: "Static files", explain: "Serves files straight from disk if the path matches one." };
  return { title: `Runs ${name}`, explain: `${name} runs before the handler and can change the request or stop it.` };
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved", 302: "Found", 303: "See Other", 307: "Temporary Redirect",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 410: "Gone", 422: "Unprocessable",
  429: "Too Many Requests", 500: "Server Error", 502: "Bad Gateway", 503: "Unavailable",
};

function statusExplain(status: number): string {
  if (status < 300) return "The request worked and the client gets its answer.";
  if (status < 400) return "The client is sent to another address.";
  if (status === 401) return "The caller isn't signed in, or the credentials were wrong.";
  if (status === 403) return "The request is refused: the caller isn't allowed to do this.";
  if (status === 404) return "What was asked for doesn't exist.";
  if (status === 409) return "It clashes with something that already exists (for example, an email already in use).";
  if (status === 429) return "The caller sent too many requests and has to wait.";
  if (status === 400 || status === 422) return "The data sent was missing or wrong.";
  if (status >= 500) return "Something failed on the server.";
  return "The request is turned down.";
}

function statusTitle(status: number): string {
  const text = STATUS_TEXT[status] ?? "";
  if (status < 300) return `Sends back ${status} ${text}`.trim();
  if (status < 400) return `Redirects (${status})`;
  if (status < 500) return `Rejects with ${status} ${text}`.trim();
  return `Fails with ${status} ${text}`.trim();
}

function dbWhat(label: string): string {
  const segs = label.replace(/^this\./, "").split(".");
  const verb = segs[segs.length - 1]!;
  // The thing being stored is named just before the first operation: prisma.user.findUnique, Comment.find(...).remove().
  const firstVerb = segs.findIndex((x, i) => i > 0 && DB_VERBS.test(x));
  let model = firstVerb > 0 ? segs[firstVerb - 1]! : segs[0]!;
  model = model.replace(/(Repository|Repo|Model|Collection|Table|Dao|Store)$/i, "") || model;
  if (/^(prisma|db|knex|pool|pg|sql|database|client|em|entityManager|dataSource|mongo|mongodb|redis|supabase|drizzle|kysely|this)$/i.test(model)) model = "";
  const thing = model ? ` ${model.charAt(0).toLowerCase()}${model.slice(1)}` : "";
  if (/^(find|get|select|count|exists|aggregate|hget|query)/i.test(verb)) return verb === "query" && !thing ? "Queries the database" : `Looks up${thing || " data"} in the database`;
  if (/^(create|insert|save|set|hset|increment|decrement)/i.test(verb)) return `Saves${thing || " data"} to the database`;
  if (/^(update|upsert)|AndUpdate$/i.test(verb)) return `Updates${thing || " data"} in the database`;
  if (/^(delete|destroy|remove|del)|AndDelete$/i.test(verb)) return `Deletes${thing || " data"} from the database`;
  if (/transaction/i.test(verb)) return "Runs a database transaction";
  return `Uses the database${thing ? ` (${thing.trim()})` : ""}`;
}

function describeSecurity(label: string): { title: string; explain: string } {
  const last = label.split(".").pop()!;
  if (/rate.?limit|limiter|throttl/i.test(label)) return { title: "Rate limit check", explain: "Counts this caller's requests and stops them if there are too many." };
  if (/^(compare|verify)$/i.test(last) && /bcrypt|argon/i.test(label)) return { title: "Checks the password", explain: "Compares the password sent with the scrambled (hashed) one stored for this user." };
  if (/(compare|verify|check)Password/i.test(last)) return { title: "Checks the password", explain: "Compares the password sent with the stored one." };
  if (/^hash/i.test(last) || /hashPassword/i.test(last)) return { title: "Hashes the password", explain: "Scrambles the password so it's never stored as plain text." };
  if (/^sign$|signToken|generateToken|createToken|issueToken|generateJwt|signJwt/i.test(last)) return { title: "Creates a login token", explain: "Makes a signed token the client keeps and sends back to prove it's signed in." };
  if (/^verify$|verifyToken|verifyJwt|jwtVerify/i.test(last)) return { title: "Checks the login token", explain: "Makes sure the token the client sent is genuine and hasn't expired." };
  if (/authenticate/i.test(last)) return { title: "Checks the credentials", explain: `${label} checks who the caller is.` };
  if (SIGN_IN_PROOF.test(last)) return { title: "Gets the signed-in user", explain: "Finds out who is making the request from their session; no session means not signed in." };
  if (/random|uuid/i.test(last)) return { title: "Makes a random secret", explain: "Generates an unguessable value (a reset code, token or ID)." };
  return { title: `Security: ${label}`, explain: `${label} does cryptography or authentication work.` };
}

function describeCall(c: FlowCall): { title: string; explain: string } {
  switch (c.kind) {
    case "input": {
      const where = c.source === "body" ? "the request body" : c.source === "query" ? "the URL query" : c.source === "params" ? "the URL path" : `the request ${c.source}`;
      const fields = c.fields ?? [];
      return {
        title: fields.length ? `Reads ${fields.slice(0, 5).join(", ")}${fields.length > 5 ? "…" : ""} from ${where}` : `Reads ${where}`,
        explain: "This is the data the client sent with the request.",
      };
    }
    case "validate":
      return { title: "Checks the input", explain: `${c.label} checks the data has the right shape before it's used.` };
    case "database":
      return { title: dbWhat(c.label), explain: `${c.label} talks to the database; the request waits for the answer.` };
    case "external":
      return {
        title: `Calls ${c.host && c.host !== "email" ? c.host : c.host === "email" ? "the email service" : "an outside service"}`,
        explain: `${c.label} sends a network request to another service; if it's slow or down, this request is too.`,
      };
    case "security":
      return describeSecurity(c.label);
    case "response":
      return { title: statusTitle(c.status ?? 200), explain: statusExplain(c.status ?? 200) };
    case "error":
      return c.status
        ? { title: `Stops with ${c.label} (${c.status})`, explain: statusExplain(c.status) }
        : { title: c.label === "next(error)" ? "Passes an error on" : `Stops with ${c.label}`, explain: "The request stops here and the app's error handler decides what the client sees." };
    case "call":
      return { title: `Calls ${c.label}()`, explain: "Goes into another part of your code." };
  }
}

export function buildFlows(allFacts: FileFacts[]): RequestFlow[] {
  const facts = allFacts.filter((f) => f.path && !f.isTest);
  const files = new Set(facts.map((f) => f.path));
  const byPath = new Map(facts.map((f) => [f.path, f]));
  const mounts = routeMounts(facts, files);

  /** `app.use(apiRouter)` mounts routes; `app.use(loadSession(store))` is middleware, even when both come from a module that has routes. */
  const isRouterName = (f: FileFacts, name: string): boolean => {
    if (f.routerAliases?.[name]) return true;
    if (/(router|routes?|api|app)$/i.test(name)) return true;
    const imp = f.imports.find((i) => i.locals?.includes(name));
    if (!imp || imp.locals!.indexOf(name) !== 0 || imp.names[0] !== "default") return false;
    const target = mounts.moduleFor(f, name);
    const t = target ? byPath.get(target) : undefined;
    return Boolean(t && t.routes.length > 0);
  };
  const underPrefix = (p: string, prefix: string) => prefix === "" || p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

  const fnIn = (file: FileFacts, pred: (name: string) => boolean): FunctionFacts | undefined => file.functionFacts?.find((fn) => pred(fn.name));

  const resolveFn = (from: FileFacts, rawName: string): Resolved | undefined => {
    const name = rawName.replace(/^this\./, "");
    const segs = name.split(".");
    const root = segs[0]!;
    const last = segs[segs.length - 1]!;
    if (rawName.startsWith("this.")) {
      const fn = fnIn(from, (n) => n.endsWith(`.${last}`));
      return fn ? { file: from, fn } : undefined;
    }
    const local = fnIn(from, (n) => n === name);
    if (local) return { file: from, fn: local };
    const imp = from.imports.find((i) => i.locals?.includes(root));
    if (imp) {
      const r = resolveImport(from.path, imp.specifier, files);
      const target = r.kind === "module" ? byPath.get(r.path) : undefined;
      if (!target) return undefined;
      const idx = imp.locals!.indexOf(root);
      const original = imp.names.length === imp.locals!.length ? imp.names[idx] : undefined;
      let fn: FunctionFacts | undefined;
      if (segs.length === 1) {
        fn = fnIn(target, (n) => n === (original ?? root)) ?? (original === "default" ? fnIn(target, (n) => n === root) : undefined);
      } else {
        const owner = original && original !== "default" ? original : undefined;
        fn =
          (owner ? fnIn(target, (n) => n === `${owner}.${last}`) : undefined) ??
          fnIn(target, (n) => n === last) ??
          fnIn(target, (n) => n === `default.${last}`) ??
          fnIn(target, (n) => n.endsWith(`.${last}`));
      }
      return fn ? { file: target, fn } : undefined;
    }
    if (segs.length >= 2) {
      // `const controller = new AuthController()`: find the method here or in a module this file imports.
      const here = fnIn(from, (n) => n.endsWith(`.${last}`));
      if (here) return { file: from, fn: here };
      for (const i of from.imports) {
        const r = resolveImport(from.path, i.specifier, files);
        const t = r.kind === "module" ? byPath.get(r.path) : undefined;
        const fn = t ? fnIn(t, (n) => n.endsWith(`.${last}`)) : undefined;
        if (t && fn) return { file: t, fn };
      }
    }
    return undefined;
  };

  // Global limiter anywhere (matches the map's rule, so the flow and the findings agree).
  const globalRateLimit = facts.some((f) => f.middlewareUses.some((u) => (!u.path || u.path === "/") && u.names.some((n) => RATE_LIMIT_RE.test(n))));
  const scopedRateLimits = facts.flatMap((f) =>
    f.middlewareUses.filter((u) => u.path && u.path !== "/" && u.names.some((n) => RATE_LIMIT_RE.test(n))).map((u) => u.path!),
  );
  const nextMiddleware = facts.find((f) => /(^|\/)(src\/)?middleware\.[cm]?[jt]s$/.test(f.path));
  const entryApps = facts.filter((f) => /(^|\/)(app|server|index|main)\.[cm]?[jt]s$/.test(f.path) && !mounts.mountsInto.has(f.path));

  /** Middleware that runs before a route: app-level, then each mounting router's, then the route's own. */
  const middlewareFor = (f: FileFacts, r: RouteFact, fullPath: string): Array<{ name: string; file: FileFacts; line: number }> => {
    const chain: FileFacts[] = [];
    const walk = (file: string, seen: Set<string>) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const m of mounts.mountsInto.get(file) ?? []) walk(m.parent, seen);
      const facts = byPath.get(file);
      if (facts) chain.push(facts);
    };
    if (r.framework === "express-like") {
      walk(f.path, new Set());
      // Routers mounted without a path (`app.use(routes)`) aren't traceable mounts: assume the app entry runs first.
      if (!chain.some((c) => entryApps.includes(c))) for (const app of entryApps) if (app.path !== f.path) chain.unshift(app);
    }
    /** In a parent file, only middleware registered before its routers are mounted runs ahead of them. */
    const cutoff = (file: FileFacts) => {
      if (file.path === f.path) return r.line;
      const mountLines = file.middlewareUses.filter((u) => (u.requires?.length ?? 0) > 0 || u.names.some((n) => isRouterName(file, n))).map((u) => u.line);
      return mountLines.length ? Math.min(...mountLines) : Infinity;
    };
    const out: Array<{ name: string; file: FileFacts; line: number }> = [];
    for (const file of chain) {
      const base = mounts.prefixesOf(file.path)[0] ?? "";
      for (const u of file.middlewareUses) {
        if (u.path && u.path !== "/" && !underPrefix(fullPath, joinPaths(base, u.path))) continue;
        if (u.line > cutoff(file)) continue; // registered after the route / router: doesn't run for it
        for (const n of u.names.flatMap((x) => x.split(","))) {
          // Routers are mounts, not steps; static file serving never runs for API routes it doesn't match.
          if (!n || isRouterName(file, n) || /^(express\.)?Router$/.test(n) || /static|serveStatic/i.test(n)) continue;
          out.push({ name: n, file, line: u.line });
        }
      }
    }
    for (const n of r.middleware.flatMap((x) => x.split(","))) if (n) out.push({ name: n, file: f, line: r.line });
    return out;
  };

  const flows: RequestFlow[] = [];
  for (const f of facts) {
    for (const declared of f.routes) {
      for (const prefix of declared.framework === "express-like" ? mounts.prefixesOf(f.path) : [""]) {
        const path = joinPaths(prefix, declared.path);
        const r: RouteFact = { ...declared, path };
        const steps: FlowStep[] = [];
        const keys = new Map<string, number>();
        const push = (s: Omit<FlowStep, "key"> & { key?: string }) => {
          if (steps.length >= MAX_STEPS) return;
          const base = s.key ?? `${s.kind}:${s.code ?? s.title}:${s.depth}`;
          const n = (keys.get(base) ?? 0) + 1;
          keys.set(base, n);
          steps.push({ ...s, key: n > 1 ? `${base}#${n}` : base });
        };

        push({ kind: "client", title: `Client sends ${r.method === "ALL" ? "a request to" : r.method} ${path}`, explain: "A browser, app or script makes an HTTP request to this address.", depth: 0, key: "client" });

        if (r.framework !== "express-like" && nextMiddleware) {
          push({ kind: "middleware", title: "Next.js middleware", explain: "middleware.ts runs before every matching request and can redirect or block it.", file: nextMiddleware.path, line: 1, depth: 0, code: "middleware" });
        }
        const mws = middlewareFor(f, r, path);
        for (const m of mws) {
          const d = describeMiddleware(m.name);
          const def = resolveFn(m.file, m.name);
          push({ kind: "middleware", ...d, code: m.name, file: def?.file.path ?? m.file.path, line: def?.fn.line ?? m.line, depth: 0 });
        }
        const guardIndex = steps.length;

        const visited = new Set<string>();
        const expand = (file: FileFacts, calls: FlowCall[], depth: number) => {
          for (const c of calls) {
            if (c.kind === "call") {
              const target = resolveFn(file, c.label);
              if (!target) continue; // not the repo's own code after all
              const key = `${target.file.path}#${target.fn.name}`;
              push({ kind: "call", title: `Calls ${target.fn.name.replace(/^default\./, "")}()`, explain: `Goes into ${target.fn.name.replace(/^default\./, "")} in ${target.file.path}.`, code: c.label, file: target.file.path, line: target.fn.line, depth });
              if (depth < MAX_DEPTH && !visited.has(key)) {
                visited.add(key);
                expand(target.file, target.fn.calls, depth + 1);
                visited.delete(key);
              }
              continue;
            }
            const d = describeCall(c);
            push({ kind: c.kind, ...d, code: c.label, file: file.path, line: c.line, depth, ...(c.kind === "response" || c.kind === "error" ? { key: `${c.kind}:${c.status ?? c.label}:${depth}` } : {}) });
          }
        };

        if (declared.handlerCalls) {
          push({ kind: "handler", title: "Runs the route's code", explain: `The function written right on the route in ${f.path} handles the request.`, file: f.path, line: r.line, depth: 0, key: "handler" });
          expand(f, declared.handlerCalls, 0);
        } else if (declared.handler) {
          const h = resolveFn(f, declared.handler);
          const shown = (h?.fn.name ?? declared.handler).replace(/^default\.?/, "") || "handler";
          push({
            kind: "handler",
            title: `Runs ${shown}()`,
            explain: h ? `The request is handled by ${shown} in ${h.file.path}.` : `The request is handled by ${declared.handler}, but its code couldn't be found in this repo.`,
            file: h?.file.path ?? f.path,
            line: h?.fn.line ?? r.line,
            code: declared.handler,
            depth: 0,
            key: "handler",
          });
          if (h) {
            visited.add(`${h.file.path}#${h.fn.name}`);
            expand(h.file, h.fn.calls, 0);
          }
        }

        // What's missing, shown where it would have been.
        const guards: FlowStep[] = [];
        const missing = (what: string, title: string, explain: string, severity: FlowStep["severity"]) =>
          guards.push({ key: `missing:${what}`, kind: "missing", title, explain, depth: 0, severity });
        const names = mws.map((m) => m.name);
        const has = (kind: FlowStep["kind"], re?: RegExp) => steps.some((s) => s.kind === kind && (!re || re.test(s.code ?? s.title)));
        // Credential endpoints: by path (/login, /reset...) or by what they do (hash / check a password, issue a login token).
        const handlesCredentials =
          r.method !== "GET" && steps.some((s) => s.kind === "security" && /^(Checks the password|Hashes the password|Creates a login token|Checks the credentials)$/.test(s.title));
        const signedIn = names.some((n) => AUTH_MIDDLEWARE.test(n) && !SESSION_LOADER.test(n)) || has("security", SIGN_IN_PROOF);
        // Guessing passwords needs anonymous access: a signed-in "change my password" route isn't the brute-force surface.
        if (isAuthRoute(r) || (handlesCredentials && !signedIn)) {
          const limited =
            names.some((n) => RATE_LIMIT_RE.test(n)) ||
            has("security", /rate.?limit|limiter|throttl/i) ||
            (r.framework === "express-like"
              ? globalRateLimit || scopedRateLimits.some((p) => underPrefix(path, p))
              : importsRateLimiter(f) || Boolean(nextMiddleware && importsRateLimiter(nextMiddleware)));
          if (!limited) {
            missing(
              "rate-limit",
              "No rate limiter",
              handlesCredentials && !isAuthRoute(r)
                ? "This handles passwords or login tokens, and nothing limits how often it can be called, so it can be hammered with guesses or fake sign-ups."
                : "Nothing limits how often this can be called, so someone can try passwords over and over until one works.",
              "high",
            );
          }
        } else if (["PUT", "PATCH", "DELETE", "POST"].includes(r.method) && !PUBLIC_PATH.test(path)) {
          if (!signedIn) {
            missing(
              "sign-in",
              "No sign-in check found",
              "This changes data, but nothing checks who the caller is. If only signed-in users should do this, add auth middleware.",
              r.method === "POST" ? "low" : "medium",
            );
          }
        }
        steps.splice(guardIndex, 0, ...guards);

        const readsBody = steps.findIndex((s) => s.kind === "input" && /request body|URL query/.test(s.title));
        const validated = has("validate") || names.some((n) => /valid|schema|celebrate|zod|joi|yup/i.test(n));
        if (readsBody >= 0 && !validated && r.method !== "GET") {
          steps.splice(readsBody + 1, 0, {
            key: "missing:validation",
            kind: "missing",
            title: "Input isn't checked",
            explain: "The data sent is used as-is. A schema check (zod, joi, express-validator) would reject bad or unexpected values first.",
            depth: steps[readsBody]!.depth,
            severity: "low",
          });
        }

        flows.push({ routeId: routeId(r.method, path), method: r.method, path, file: f.path, line: r.line, steps });
      }
    }
  }
  const seen = new Set<string>();
  return flows.filter((fl) => (seen.has(fl.routeId) ? false : (seen.add(fl.routeId), true)));
}

/** Longest common subsequence merge of two step lists by key. */
function mergeSteps(before: FlowStep[], after: FlowStep[]): FlowStepChange[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i]!.key === after[j]!.key ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: FlowStepChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i]!.key === after[j]!.key) {
      out.push({ ...after[j]!, change: "same" });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Removed before added, so a replaced step reads "was -> now".
      out.push({ ...before[i]!, change: "removed" });
      i++;
    } else {
      out.push({ ...after[j]!, change: "added" });
      j++;
    }
  }
  return out;
}

function summarize(steps: FlowStepChange[]): string {
  const parts: string[] = [];
  for (const s of steps) {
    if (s.change === "same" || s.kind === "client") continue;
    if (s.kind === "missing") parts.push(s.change === "added" ? `⚠ now: ${s.title.toLowerCase()}` : `fixed: ${s.title.replace(/^No /, "").replace(/ found$/, "").toLowerCase()}`);
    else if (s.depth <= 1) parts.push(`${s.change === "added" ? "+" : "−"} ${s.title.charAt(0).toLowerCase()}${s.title.slice(1)}`);
  }
  if (parts.length === 0) return steps.some((s) => s.change !== "same") ? "Internal steps changed" : "No change";
  return parts.length > 5 ? `${parts.slice(0, 5).join("; ")}; …` : parts.join("; ");
}

/** How every request's path through the code changed between two versions. Unchanged flows are included with status "same". */
export function diffFlows(before: RequestFlow[], after: RequestFlow[]): FlowDiff[] {
  const b = new Map(before.map((f) => [f.routeId, f]));
  const a = new Map(after.map((f) => [f.routeId, f]));
  const out: FlowDiff[] = [];
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(id);
    const y = a.get(id);
    const flow = (y ?? x)!;
    const label = `${flow.method} ${flow.path}`;
    if (!x) {
      const gaps = y!.steps.filter((s) => s.kind === "missing").map((s) => `⚠ ${s.title.toLowerCase()}`);
      out.push({ routeId: id, label, status: "added", steps: y!.steps.map((s) => ({ ...s, change: "added" })), summary: ["New request path", ...gaps].join("; ") });
    }
    else if (!y) out.push({ routeId: id, label, status: "removed", steps: x.steps.map((s) => ({ ...s, change: "removed" })), summary: "Request path removed" });
    else {
      const steps = mergeSteps(x.steps, y.steps);
      const changed = steps.some((s) => s.change !== "same");
      out.push({ routeId: id, label, status: changed ? "changed" : "same", steps, summary: summarize(steps) });
    }
  }
  // Most serious first: a safeguard that just went missing (high before low), then changed, new and removed requests.
  const SEV = { critical: 0, high: 0, medium: 1, low: 2, info: 2 } as const;
  const rank = (d: FlowDiff) => {
    const gaps = d.steps.filter((s) => s.kind === "missing" && s.change === "added").map((s) => SEV[s.severity ?? "low"]);
    return (gaps.length ? Math.min(...gaps) : 3) * 10 + (d.status === "same" ? 9 : d.status === "changed" ? 0 : d.status === "added" ? 1 : 2);
  };
  return out.sort((p, q) => rank(p) - rank(q) || p.label.localeCompare(q.label));
}
