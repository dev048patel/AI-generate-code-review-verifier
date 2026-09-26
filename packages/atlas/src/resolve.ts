import { builtinModules } from "node:module";
import path from "node:path";
import type { FileFacts, RouteFact } from "./types.js";

/** Import resolution, route identity and router mounting: shared by the map and request flows. */

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const ASSET_RE = /\.(css|scss|sass|less|json|svg|png|jpe?g|gif|webp|ico|md|html|txt|wasm|graphql|gql|yml|yaml)(\?.*)?$/i;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Login, sign-up, password reset, token and OTP endpoints: the brute-force / credential-stuffing surface. */
export const AUTH_PATH_RE =
  /(^|\/)(login|log-in|logon|signin|sign-in|signup|sign-up|register|auth|authenticate|token|oauth|password|passwd|reset|forgot|otp|verify|2fa|mfa|session|magic-link)s?(\/|$|:|\?)/i;
/** Names that indicate rate limiting / throttling middleware. */
export const RATE_LIMIT_RE = /rate.?limit|limiter|throttl|slow.?down|brute|\w+Limit\b|^limit/i;
const RATE_LIMIT_PACKAGES = /^(express-rate-limit|rate-limiter-flexible|@fastify\/rate-limit|express-slow-down|express-brute|@upstash\/ratelimit|@nestjs\/throttler|koa-ratelimit|hono-rate-limiter|limiter)$/;

/** Ending a session isn't a credential-guessing surface, even under /auth/. */
const LOGOUT_RE = /(^|\/)(logout|log-out|logoff|signout|sign-out)\/?$/i;

export function packageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0]!;
}

export type Resolution =
  | { kind: "module"; path: string }
  | { kind: "package"; name: string }
  | { kind: "missing" }
  | { kind: "ignored" };

/** Resolves an import the way bundlers/Node usually would, against the set of files in the repo. */
export function resolveImport(from: string, spec: string, files: ReadonlySet<string>): Resolution {
  if (ASSET_RE.test(spec) || spec.startsWith("#") || /^(https?|data|virtual):/.test(spec)) return { kind: "ignored" };
  if (BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]!)) return { kind: "ignored" };

  const tryBase = (base: string): string | undefined => {
    const b = path.posix.normalize(base);
    const candidates = [b];
    const jsExt = /\.(js|jsx|mjs|cjs)$/.exec(b);
    if (jsExt) {
      const stem = b.slice(0, -jsExt[0].length);
      const map: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
      for (const e of map[jsExt[0]] ?? []) candidates.push(stem + e);
    }
    for (const e of RESOLVE_EXTS) candidates.push(b + e);
    for (const e of RESOLVE_EXTS) candidates.push(`${b}/index${e}`);
    return candidates.find((c) => files.has(c));
  };

  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = spec.startsWith("/") ? spec.slice(1) : path.posix.join(path.posix.dirname(from), spec);
    const hit = tryBase(base);
    return hit ? { kind: "module", path: hit } : { kind: "missing" };
  }
  // Common path aliases (tsconfig "paths"): "@/x" and "~/x" -> src/x or x.
  const alias = /^[@~]\/(.*)$/.exec(spec);
  if (alias) {
    const hit = tryBase(`src/${alias[1]}`) ?? tryBase(alias[1]!);
    return hit ? { kind: "module", path: hit } : { kind: "ignored" };
  }
  return { kind: "package", name: packageName(spec) };
}

/** Route identity ignores parameter names: `/articles/:article` and `/articles/:slug` are the same endpoint. */
export function normalizeRoutePath(p: string): string {
  return p.replace(/:[^/]+/g, ":*").replace(/\*[^/]+/g, "*").replace(/\[[^\]]+\]/g, ":*");
}

export function routeId(method: string, p: string): string {
  return `r:${method} ${normalizeRoutePath(p)}`;
}

export function isAuthRoute(r: Pick<RouteFact, "method" | "path">): boolean {
  return AUTH_PATH_RE.test(r.path) && !LOGOUT_RE.test(r.path) && ["POST", "PUT", "PATCH", "ALL"].includes(r.method);
}

export function joinPaths(prefix: string, p: string): string {
  if (!prefix) return p;
  const joined = `${prefix.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

export function importsRateLimiter(f: FileFacts): boolean {
  return f.imports.some((i) => RATE_LIMIT_PACKAGES.test(packageName(i.specifier)) || RATE_LIMIT_RE.test(i.specifier.split("/").pop() ?? ""));
}

export interface RouteMounts {
  /** Every path prefix a module's routes are served under (["" ] when it isn't mounted anywhere). */
  prefixesOf: (file: string) => string[];
  /** Modules that mount this one: `app.use("/api", router)` in app.ts -> router.ts is mounted by app.ts under "/api". */
  mountsInto: Map<string, Array<{ parent: string; prefix: string }>>;
  /** Which module a local name in a file comes from. */
  moduleFor: (file: FileFacts, local: string) => string | undefined;
}

/**
 * Router mounts: `app.use("/profiles", profileRouter)` where profileRouter is imported
 * from another module prefixes every route that module declares.
 */
export function routeMounts(facts: FileFacts[], files: ReadonlySet<string>): RouteMounts {
  const moduleFor = (f: FileFacts, local: string): string | undefined => {
    const imp = f.imports.find((i) => i.locals?.includes(local.split(".")[0]!));
    const r = imp ? resolveImport(f.path, imp.specifier, files) : undefined;
    return r?.kind === "module" ? r.path : undefined;
  };
  const mountsInto = new Map<string, Array<{ parent: string; prefix: string }>>();
  const mount = (child: string, parent: string, prefix: string) => {
    if (child === parent) return;
    const list = mountsInto.get(child) ?? [];
    if (!list.some((m) => m.parent === parent && m.prefix === prefix)) list.push({ parent, prefix });
    mountsInto.set(child, list);
  };
  for (const f of facts) {
    for (const use of f.middlewareUses) {
      if (!use.path || use.path === "/") continue;
      for (const spec of use.requires ?? []) {
        const r = resolveImport(f.path, spec, files);
        if (r.kind === "module") mount(r.path, f.path, use.path);
      }
      for (const name of use.names) {
        const direct = moduleFor(f, name);
        if (direct) mount(direct, f.path, use.path);
        // A local router composed of imported ones: mount each of them under this prefix.
        for (const part of f.routerAliases?.[name] ?? []) {
          const m = moduleFor(f, part);
          if (m) mount(m, f.path, use.path);
        }
      }
    }
  }
  const prefixCache = new Map<string, string[]>();
  const prefixesOf = (file: string, seen: Set<string> = new Set()): string[] => {
    const cached = prefixCache.get(file);
    if (cached) return cached;
    const mounts = mountsInto.get(file);
    if (!mounts || seen.has(file)) return [""];
    seen.add(file);
    const out = [...new Set(mounts.flatMap((m) => prefixesOf(m.parent, seen).map((p) => joinPaths(p, m.prefix))))];
    prefixCache.set(file, out);
    return out;
  };
  return { prefixesOf, mountsInto, moduleFor };
}
