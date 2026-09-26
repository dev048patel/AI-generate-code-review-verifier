import ts from "typescript";
import type { FlowCall, FunctionFacts, ImportFact } from "./types.js";

/**
 * What a function body does, in order, reduced to the steps a person would
 * narrate: reads input, validates it, talks to the database or another
 * service, checks passwords / tokens, calls into other code, responds.
 * Syntax only: names are matched against common library and naming patterns.
 */

const RESPONSE_ROOTS = new Set(["res", "reply", "response", "resp", "c", "ctx"]);
const RESPONSE_METHODS = new Set(["json", "send", "end", "redirect", "sendStatus", "render", "sendFile", "code", "html", "text"]);
const RESPONSE_FACTORIES = /^(NextResponse|Response)\.(json|redirect)$/;

const DB_LIBS = /^(prisma|knex|sequelize|mongoose|drizzle|supabase|redis|mongo|mongodb|pool|pg|sql|db|database|dataSource|entityManager|em|typeorm|kysely|firestore|dynamo|dynamodb)$/i;
const DB_HOLDER = /(repo|repository|model|collection|table|dao|store|db)$/i;
/** Query-builder / promise methods that follow the real operation: `Comment.find(q).remove().exec()`. */
const CHAIN_TAIL = /^(then|catch|finally|exec|lean|populate|sort|limit|skip|orFail|toArray|returning|select|where|orderBy|first|single|maybeSingle|throwOnError)$/;
export const DB_VERBS =
  /^(find|findOne|findById|findByPk|findAll|findMany|findUnique|findFirst|findOneAndUpdate|findByIdAndUpdate|findByIdAndDelete|findOneAndDelete|findUniqueOrThrow|findFirstOrThrow|create|createMany|insert|insertOne|insertMany|update|updateOne|updateMany|upsert|delete|deleteOne|deleteMany|destroy|save|remove|query|execute|exec|select|count|aggregate|exists|increment|decrement|get|set|del|hget|hset|transaction|\$transaction|\$queryRaw|\$executeRaw)$/;
const DB_SPECIFIER = /(model|schema|entit|(^|\/)db\b|database|prisma|repositor|drizzle|knex)/i;

const HTTP_CLIENTS = /^(fetch|axios|got|ky|superagent|request|needle|undici|ofetch|\$fetch)$/;
const HTTP_METHODS = /^(get|post|put|patch|delete|head|request|fetch)$/;
const SERVICE_SDKS = /^(stripe|twilio|sendgrid|sgMail|mailgun|resend|openai|anthropic|octokit|s3|s3Client|sqs|sns|ses|slack|transporter|mailer|pusher|algolia)$/i;

const SECURITY_LIBS = /^(bcrypt|bcryptjs|argon2|jwt|jsonwebtoken|jose|crypto|passport|speakeasy|otplib|scrypt|nacl|sodium)$/;
const SECURITY_NAMES = /^(hash|compare|verify)(Password|Pass|Pw)$|^(hashPassword|comparePassword|verifyPassword|checkPassword|generateToken|signToken|verifyToken|createToken|issueToken|generateJwt|signJwt|verifyJwt)$/i;

const SESSION_NAMES = /^(getServerSession|getSession|auth|currentUser|requireUser|requireAuth|getAuth|verifySession|validateRequest|getCurrentUser|requireSession)$/;

const VALIDATE_METHODS = /^(parse|safeParse|parseAsync|safeParseAsync|validate|validateAsync|validateSync|validateOrReject|assert|is)$/;
const VALIDATE_NAMES = /^(validate\w*|validationResult|checkSchema|assertValid\w*|isValid\w*)$/;
const NOT_VALIDATORS = /^(JSON|Number|Date|path|url|URL|qs|querystring|parseInt|parseFloat|Math|BigInt|semver|yaml|YAML|cookie|cookies)$/;

const INPUT_SOURCES = new Set(["body", "query", "params", "headers", "cookies", "files", "file"]);

export interface CallContext {
  imports: ImportFact[];
  /** Names of functions defined in the same file (top level, class members as `Class.method`, object members as `obj.method`). */
  localFunctions: Set<string>;
  /** Variables declared inside the body being analyzed: `const res = await fetch(...)` is not the HTTP response. */
  declared?: Set<string>;
}

/** `a.b(1).c` -> "a.b.c"; `this.repo.find` -> "this.repo.find". */
export function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeName(expr.expression);
    return left ? `${left}.${expr.name.text}` : expr.name.text;
  }
  if (ts.isCallExpression(expr)) return calleeName(expr.expression);
  if (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) return calleeName(expr.expression);
  if (ts.isAsExpression(expr)) return calleeName(expr.expression);
  if (ts.isElementAccessExpression(expr)) return calleeName(expr.expression);
  return undefined;
}

function literalNumber(expr: ts.Expression | undefined): number | undefined {
  if (expr && ts.isNumericLiteral(expr)) return Number(expr.text);
  return undefined;
}

function statusFromOptions(expr: ts.Expression | undefined): number | undefined {
  if (!expr || !ts.isObjectLiteralExpression(expr)) return literalNumber(expr);
  for (const p of expr.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "status") return literalNumber(p.initializer);
  }
  return undefined;
}

function urlHost(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  let text: string | undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) text = expr.text;
  else if (ts.isTemplateExpression(expr)) text = expr.head.text;
  if (!text) return undefined;
  const m = /^https?:\/\/([^/?#:]+)/.exec(text);
  return m?.[1];
}

/** Everything left of the last dot, minus a leading `this.`: `this.userRepo.find` -> ["userRepo", "find"]. */
function segments(name: string): string[] {
  return name.replace(/^this\./, "").split(".");
}

function importFor(ctx: CallContext, local: string): ImportFact | undefined {
  return ctx.imports.find((i) => i.locals?.includes(local));
}

function isRelative(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("src/");
}

/** Classifies one call; undefined = not worth a step (console.log, array methods, ...). */
export function classifyCall(node: ts.CallExpression, ctx: CallContext, line: number): FlowCall | undefined {
  const name = calleeName(node.expression);
  if (!name) return undefined;
  const segs = segments(name);
  const root = segs[0]!;
  const last = segs[segs.length - 1]!;
  const imp = importFor(ctx, root);

  // Responses: res.json(...), res.status(401).json(...), res.sendStatus(204), NextResponse.json(x, { status }), c.json(x, 201)
  if (RESPONSE_ROOTS.has(root) && ctx.declared?.has(root)) return undefined;
  if (RESPONSE_ROOTS.has(root) && segs.length >= 2 && RESPONSE_METHODS.has(last)) {
    let status: number | undefined;
    if (last === "sendStatus" || last === "code") status = literalNumber(node.arguments[0]);
    else if (last === "redirect") status = literalNumber(node.arguments[0]) ?? 302;
    else if (root === "c" || root === "ctx") status = literalNumber(node.arguments[1]);
    // walk the chain for .status(n)
    let e: ts.Expression = node.expression;
    while (status === undefined && ts.isPropertyAccessExpression(e) && ts.isCallExpression(e.expression)) {
      const inner = e.expression;
      if (ts.isPropertyAccessExpression(inner.expression) && ["status", "code"].includes(inner.expression.name.text)) status = literalNumber(inner.arguments[0]);
      e = inner.expression;
    }
    if (root === "c" && segs.length !== 2) return undefined;
    return { kind: "response", label: name, line, status: status ?? 200 };
  }
  if (RESPONSE_FACTORIES.test(name)) {
    return { kind: "response", label: name, line, status: last === "redirect" ? 307 : (statusFromOptions(node.arguments[1]) ?? 200) };
  }
  // `res.status(400)` on its own line is picked up by the chained call above; skip the inner call.
  if (RESPONSE_ROOTS.has(root) && last === "status") return undefined;

  // next(err): hands an error to the error handler.
  if (name === "next" && node.arguments.length > 0 && !ts.isStringLiteral(node.arguments[0]!)) {
    return { kind: "error", label: "next(error)", line };
  }

  // Database. A chain is one operation: classify only its outermost call, minus trailing builder / promise methods.
  const dbSegs = [...segs];
  while (dbSegs.length > 2 && CHAIN_TAIL.test(dbSegs[dbSegs.length - 1]!)) dbSegs.pop();
  const outer = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ts.isCallExpression(node.parent.parent);
  const dbLast = dbSegs[dbSegs.length - 1]!;
  const holder = segs.length >= 2 ? segs[segs.length - 2]! : "";
  const pascalRoot = /^[A-Z][a-zA-Z0-9]*$/.test(root) && !/(Service|Controller|Handler|Helper|Utils?|Error|Response)$/.test(root);
  const dbImport = imp && DB_SPECIFIER.test(imp.specifier);
  if (
    dbSegs.length >= 2 &&
    (DB_LIBS.test(root) ||
      (DB_VERBS.test(dbLast) && (DB_HOLDER.test(holder) || DB_HOLDER.test(root) || dbImport || (pascalRoot && (!imp || dbImport)))))
  ) {
    const outerName = outer ? (node.parent as ts.PropertyAccessExpression).name.text : undefined;
    if (outerName && (DB_VERBS.test(outerName) || CHAIN_TAIL.test(outerName))) return undefined; // the outer call tells it
    return { kind: "database", label: dbSegs.join("."), line };
  }

  // Outside services.
  const literalHost = urlHost(node.arguments[0]);
  if (literalHost && !RESPONSE_ROOTS.has(root)) return { kind: "external", label: name, line, host: literalHost };
  if (HTTP_CLIENTS.test(root) && (segs.length === 1 || HTTP_METHODS.test(last))) {
    return { kind: "external", label: name, line, host: urlHost(node.arguments[0]) };
  }
  if (/^https?$/.test(root) && /^(get|request)$/.test(last)) return { kind: "external", label: name, line, host: urlHost(node.arguments[0]) };
  if (SERVICE_SDKS.test(root) && segs.length >= 2) return { kind: "external", label: name, line, host: root };
  if (last === "sendMail") return { kind: "external", label: name, line, host: "email" };

  // Rate limiting done inside the handler (rate-limiter-flexible, upstash): limiter.consume(ip).
  if (/rate.?limit|limiter|throttl/i.test(root) && segs.length >= 2) return { kind: "security", label: name, line };
  // Session / sign-in lookups: auth(), getServerSession(), currentUser().
  if (segs.length === 1 && SESSION_NAMES.test(root)) return { kind: "security", label: name, line };

  // Passwords, tokens, crypto.
  if ((SECURITY_LIBS.test(root) && segs.length >= 2) || SECURITY_NAMES.test(last)) {
    // A local helper like hashPassword() is followed into instead, so its own steps show.
    if (!(segs.length === 1 && (ctx.localFunctions.has(root) || (imp && isRelative(imp.specifier))))) {
      return { kind: "security", label: name, line };
    }
  }

  // Validation.
  if (!NOT_VALIDATORS.test(root) && ((segs.length >= 2 && VALIDATE_METHODS.test(last) && last !== "is") || VALIDATE_NAMES.test(last))) {
    if (!(segs.length === 1 && (ctx.localFunctions.has(root) || (imp && isRelative(imp.specifier))))) {
      return { kind: "validate", label: name, line };
    }
  }

  // Calls into the repo's own code: followed by the flow builder.
  const joined = segs.join(".");
  if (ctx.localFunctions.has(joined) || (segs.length === 2 && ctx.localFunctions.has(`${root}.${last}`))) return { kind: "call", label: joined, line };
  if (segs.length === 1 && ctx.localFunctions.has(root)) return { kind: "call", label: root, line };
  if (name.startsWith("this.") && segs.length === 1) return { kind: "call", label: `this.${last}`, line };
  if (imp && isRelative(imp.specifier) && segs.length <= 2) return { kind: "call", label: segs.join("."), line };
  return undefined;
}

/** Where the request's data comes from: req.body, request.json(), ctx.request.body, c.req.json(). */
function inputSource(expr: ts.Expression): string | undefined {
  const name = calleeName(expr);
  if (!name) return undefined;
  const segs = name.split(".");
  const last = segs[segs.length - 1]!;
  const root = segs[0]!;
  if (!/^(req|request|ctx|c|event|context)$/.test(root)) return undefined;
  if (segs.length >= 2 && INPUT_SOURCES.has(last)) return last === "file" ? "files" : last;
  if (ts.isCallExpression(expr) && /^(json|formData|text)$/.test(last)) return "body";
  if (ts.isAwaitExpression(expr) && ts.isCallExpression(expr.expression)) return inputSource(expr.expression);
  if (last === "searchParams" || (segs.includes("nextUrl") && last === "searchParams")) return "query";
  return undefined;
}

function bindingNames(pattern: ts.BindingName): string[] {
  if (ts.isIdentifier(pattern)) return [pattern.text];
  const out: string[] = [];
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : undefined;
    if (key) out.push(key);
  }
  return out;
}

const MAX_CALLS = 40;

/** The steps inside one function body (nested callbacks included, since they run as part of it). */
export function analyzeBody(body: ts.Node, outer: CallContext, lineOf: (n: ts.Node) => number): FlowCall[] {
  const declared = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) declared.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(body);
  const ctx: CallContext = { ...outer, declared };
  const out: FlowCall[] = [];
  const inputs = new Map<string, FlowCall>();
  const seen = new Set<string>();
  const push = (c: FlowCall) => {
    const key = `${c.kind}|${c.label}|${c.status ?? ""}`;
    if (seen.has(key) || out.length >= MAX_CALLS) return;
    seen.add(key);
    out.push(c);
  };
  const addInput = (source: string, fields: string[], line: number) => {
    const existing = inputs.get(source);
    if (existing) {
      for (const f of fields) if (!existing.fields!.includes(f)) existing.fields!.push(f);
      return;
    }
    const step: FlowCall = { kind: "input", label: `request.${source}`, source, fields: [...fields], line };
    inputs.set(source, step);
    if (out.length < MAX_CALLS) out.push(step);
  };

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const src = inputSource(node.initializer);
      if (src) addInput(src, ts.isIdentifier(node.name) ? [] : bindingNames(node.name), lineOf(node));
    } else if (
      ts.isPropertyAccessExpression(node) &&
      !ts.isPropertyAccessExpression(node.parent) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      // req.body.email
      const src = inputSource(node.expression);
      if (src) addInput(src, [node.name.text], lineOf(node));
    } else if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
      const src = inputSource(node);
      const outer = node.parent;
      if (src && !(ts.isCallExpression(outer.parent) && outer.parent.expression === outer)) addInput(src, [outer.name.text], lineOf(node));
    }
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const ctor = calleeName(node.expression.expression) ?? "Error";
      const status = (node.expression.arguments ?? []).map((a) => literalNumber(a) ?? statusFromOptions(a)).find((n) => n !== undefined && n >= 400 && n < 600);
      push({ kind: "error", label: ctor, line: lineOf(node), ...(status ? { status } : {}) });
    }
    if (ts.isNewExpression(node) && calleeName(node.expression) === "Response") {
      push({ kind: "response", label: "new Response", line: lineOf(node), status: statusFromOptions(node.arguments?.[1]) ?? 200 });
    }
    if (ts.isCallExpression(node)) {
      // `schema.parse(await request.json())`: reading the body inline, not into a variable.
      if (!ts.isVariableDeclaration(node.parent) && !(ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent))) {
        const src = inputSource(node);
        if (src) addInput(src, [], lineOf(node));
      }
      const c = classifyCall(node, ctx, lineOf(node));
      // Visit arguments first so `res.json(await findUser())` reads in execution order.
      ts.forEachChild(node, visit);
      if (c) push(c);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/** Unwraps `asyncHandler(async (req, res) => {...})` / `catchAsync(fn)` to the function inside. */
export function unwrapFunction(expr: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined {
  let e = expr;
  for (let i = 0; e && i < 3; i++) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isCallExpression(e) && e.arguments.length > 0) e = e.arguments[e.arguments.length - 1];
    else return undefined;
  }
  return undefined;
}

/** `asyncHandler(login)` -> "login"; `auth.login` -> "auth.login". */
export function handlerName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) return calleeName(expr);
  if (ts.isCallExpression(expr)) {
    const last = expr.arguments[expr.arguments.length - 1];
    if (last && (ts.isIdentifier(last) || ts.isPropertyAccessExpression(last))) return calleeName(last);
    // `controller.login.bind(controller)`
    if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "bind") return calleeName(expr.expression.expression);
  }
  return undefined;
}

/** Named functions in a file: declarations, `const f = () => {}`, class members, object-literal members, `exports.f = ...`. */
export function collectFunctions(source: ts.SourceFile): Array<{ name: string; node: ts.FunctionLikeDeclaration; line: number }> {
  const out: Array<{ name: string; node: ts.FunctionLikeDeclaration; line: number }> = [];
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const add = (name: string, node: ts.FunctionLikeDeclaration | undefined, at: ts.Node) => {
    if (node && node.body) out.push({ name, node, line: lineOf(at) });
  };
  const isDefault = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  const members = (owner: string, obj: ts.ObjectLiteralExpression) => {
    for (const p of obj.properties) {
      if (ts.isMethodDeclaration(p) && p.name && ts.isIdentifier(p.name)) add(`${owner}.${p.name.text}`, p, p);
      else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) add(`${owner}.${p.name.text}`, unwrapFunction(p.initializer), p);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, node, node);
      if (isDefault(node)) add("default", node, node);
    } else if (ts.isFunctionDeclaration(node) && isDefault(node)) {
      add("default", node, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = unwrapFunction(node.initializer);
      if (fn) add(node.name.text, fn, node);
      else if (ts.isObjectLiteralExpression(node.initializer)) members(node.name.text, node.initializer);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const cls = node.name?.text ?? "default";
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) add(`${cls}.${m.name.text}`, m, m);
        else if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.initializer) add(`${cls}.${m.name.text}`, unwrapFunction(m.initializer), m);
      }
    } else if (ts.isExportAssignment(node)) {
      const fn = unwrapFunction(node.expression);
      if (fn) add("default", fn, node);
      else if (ts.isObjectLiteralExpression(node.expression)) members("default", node.expression);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      // exports.login = ..., module.exports.login = ..., module.exports = { ... }
      const target = calleeName(node.left);
      if (target && /^(module\.)?exports\.\w+$/.test(target)) add(node.left.name.text, unwrapFunction(node.right), node);
      else if (target === "module.exports") {
        const fn = unwrapFunction(node.right);
        if (fn) add("default", fn, node);
        else if (ts.isObjectLiteralExpression(node.right)) members("default", node.right);
      }
    }
    // Functions nested inside other functions are part of their parent's body, not separate stops.
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return out;
}

export function functionFacts(source: ts.SourceFile, imports: ImportFact[]): { facts: FunctionFacts[]; ctx: CallContext } {
  const fns = collectFunctions(source);
  const ctx: CallContext = { imports, localFunctions: new Set(fns.map((f) => f.name)) };
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const facts = fns.map((f) => ({ name: f.name, line: f.line, calls: analyzeBody(f.node.body!, ctx, lineOf) }));
  return { facts, ctx };
}
