import ts from "typescript";
import { analyzeBody, functionFacts, handlerName, unwrapFunction } from "./calls.js";
import type { FileFacts, HttpMethod, ImportFact, MiddlewareUseFact, RouteFact } from "./types.js";

export const CODE_FILE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|__mocks__)\//;
const ROUTER_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);
const NEXT_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path) || /(^|\/)(test|tests|e2e|spec)\//.test(path);
}

export function isCodeFile(path: string): boolean {
  return CODE_FILE_RE.test(path) && !path.endsWith(".d.ts") && !/(^|\/)node_modules\//.test(path);
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** A readable name for a middleware argument: `limiter`, `rateLimit(...)` -> "rateLimit", `auth.required` -> "auth.required". */
function exprName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = exprName(expr.expression);
    return left ? `${left}.${expr.name.text}` : expr.name.text;
  }
  if (ts.isCallExpression(expr)) return exprName(expr.expression);
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.map((e) => exprName(e as ts.Expression)).filter(Boolean).join(",");
  if (ts.isObjectLiteralExpression(expr)) {
    // Fastify-style route options: { preHandler: [...], config: { rateLimit: {...} } }
    const keys: string[] = [];
    const walk = (o: ts.ObjectLiteralExpression) => {
      for (const p of o.properties) {
        if (!p.name) continue;
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
        if (key) keys.push(key);
        if (ts.isPropertyAssignment(p)) {
          if (ts.isObjectLiteralExpression(p.initializer)) walk(p.initializer);
          else {
            const n = exprName(p.initializer);
            if (n) keys.push(n);
          }
        }
      }
    };
    walk(expr);
    return keys.join(",");
  }
  return undefined;
}

function stringValue(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return undefined;
}

/** Next.js file-system routes: app/**\/route.ts and pages/api/**. */
export function nextRoutePath(path: string): { path: string; framework: "next-app" | "next-pages" } | undefined {
  const app = /(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/.exec(path);
  if (app) {
    const segs = (app[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return { path: "/" + segs.map((s) => s.replace(/^\[\.\.\.(.+)\]$/, "*$1").replace(/^\[(.+)\]$/, ":$1")).join("/"), framework: "next-app" };
  }
  const pages = /(?:^|\/)pages\/(api\/.*?)\.[cm]?[jt]sx?$/.exec(path);
  if (pages) {
    const p = (pages[1] ?? "").replace(/\/index$/, "");
    return { path: "/" + p.split("/").map((s) => s.replace(/^\[\.\.\.(.+)\]$/, "*$1").replace(/^\[(.+)\]$/, ":$1")).join("/"), framework: "next-pages" };
  }
  return undefined;
}

/**
 * Parses one file (syntax only, no type-checking -- fast enough to run on
 * every version of every file in a repo's history) into the facts the map
 * is built from.
 */
export function extractFacts(path: string, content: string): FileFacts {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const imports: ImportFact[] = [];
  const exports = new Set<string>();
  const routes: RouteFact[] = [];
  const middlewareUses: MiddlewareUseFact[] = [];
  const routerAliases: Record<string, string[]> = {};
  /** Route -> its handler expression, analyzed once imports and local functions are known. */
  const handlerExprs = new Map<RouteFact, ts.Expression>();
  let exportsStar = false;
  let functions = 0;
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const hasExport = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      functions++;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      const locals: string[] = [];
      if (clause?.name) {
        names.push("default");
        locals.push(clause.name.text);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          names.push((el.propertyName ?? el.name).text);
          locals.push(el.name.text);
        }
      } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        locals.push(clause.namedBindings.name.text);
      }
      imports.push({
        specifier: node.moduleSpecifier.text,
        names,
        locals,
        kind: "static",
        typeOnly: Boolean(clause?.isTypeOnly),
        line: lineOf(node),
      });
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const names: string[] = [];
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            names.push((el.propertyName ?? el.name).text);
            exports.add(el.name.text);
          }
        } else {
          exportsStar = true;
        }
        imports.push({ specifier: node.moduleSpecifier.text, names, kind: "reexport", typeOnly: node.isTypeOnly, line: lineOf(node) });
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) exports.add(el.name.text);
      }
    } else if (ts.isExportAssignment(node)) {
      exports.add("default");
    } else if (hasExport(node)) {
      if (hasDefault(node)) exports.add("default");
      else if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) exports.add(d.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) &&
        node.name
      ) {
        exports.add(node.name.text);
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // require("x") / import("x")
      if (ts.isIdentifier(callee) && callee.text === "require" && node.arguments.length === 1) {
        const spec = stringValue(node.arguments[0]);
        const binding = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? [node.parent.name.text] : [];
        if (spec) imports.push({ specifier: spec, names: [], locals: binding, kind: "require", typeOnly: false, line: lineOf(node) });
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
        const spec = stringValue(node.arguments[0]);
        if (spec) imports.push({ specifier: spec, names: [], kind: "dynamic", typeOnly: false, line: lineOf(node) });
      } else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const firstPath = stringValue(node.arguments[0]);
        if (ROUTER_METHODS.has(method) && firstPath?.startsWith("/") && node.arguments.length >= 2) {
          // app.post("/login", limiter, handler): everything between the path and the last argument is middleware.
          const middle = node.arguments.slice(1, -1);
          const route: RouteFact = {
            method: method.toUpperCase() as HttpMethod,
            path: firstPath,
            line: lineOf(node),
            framework: "express-like",
            middleware: middle.map((a) => exprName(a)).filter((n): n is string => Boolean(n)),
          };
          routes.push(route);
          handlerExprs.set(route, node.arguments[node.arguments.length - 1]!);
        } else if (method === "use" || method === "register") {
          const args = [...node.arguments];
          const mountPath = stringValue(args[0]);
          if (mountPath !== undefined) args.shift();
          const names = args.map((a) => exprName(a)).filter((n): n is string => Boolean(n) && n !== "require");
          const requires = args
            .filter((a): a is ts.CallExpression => ts.isCallExpression(a) && ts.isIdentifier(a.expression) && a.expression.text === "require")
            .map((a) => stringValue(a.arguments[0]))
            .filter((x): x is string => Boolean(x));
          if (names.length > 0 || requires.length > 0) {
            middlewareUses.push({ path: mountPath, names, ...(requires.length ? { requires } : {}), line: lineOf(node) });
          }
        }
      }
    }

    // const api = Router().use(a).use(b): remember what the local router is made of.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const parts: string[] = [];
      let e: ts.Expression = node.initializer;
      while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
        if (e.expression.name.text === "use") {
          for (const a of e.arguments) {
            if (ts.isIdentifier(a)) parts.push(a.text);
          }
        }
        e = e.expression.expression;
      }
      if (parts.length > 0) routerAliases[node.name.text] = parts;
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  const next = nextRoutePath(path);
  if (next) {
    if (next.framework === "next-app") {
      for (const name of exports) {
        if (NEXT_METHODS.has(name)) routes.push({ method: name as HttpMethod, path: next.path, line: 1, framework: "next-app", middleware: [] });
      }
    } else if (exports.has("default")) {
      routes.push({ method: "ALL", path: next.path, line: 1, framework: "next-pages", middleware: [] });
    }
  }

  // What each function and each inline route handler does, for request flows.
  const { facts: fnFacts, ctx } = functionFacts(source, imports);
  for (const [route, expr] of handlerExprs) {
    const fn = unwrapFunction(expr);
    if (fn?.body) route.handlerCalls = analyzeBody(fn.body, ctx, lineOf);
    else {
      const name = handlerName(expr);
      if (name) route.handler = name;
    }
  }
  for (const r of routes) {
    if (r.framework === "next-app") r.handler = r.method;
    else if (r.framework === "next-pages") r.handler = "default";
  }

  return {
    path,
    loc: content.split("\n").filter((l) => l.trim().length > 0).length,
    imports,
    exports: [...exports],
    exportsStar,
    routes,
    middlewareUses,
    functions,
    isTest: isTestFile(path),
    ...(Object.keys(routerAliases).length ? { routerAliases } : {}),
    ...(fnFacts.length ? { functionFacts: fnFacts } : {}),
  };
}
