/** Shared types for Repo Atlas: a repo's structure as a graph, how it changes per commit, and how it behaves at runtime. */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL" | "OPTIONS" | "HEAD";

export interface ImportFact {
  specifier: string;
  /** Named bindings imported ("default" for a default import); empty for side-effect / namespace imports. */
  names: string[];
  /** Local binding names this import creates (for following `app.use("/api", apiRouter)` to the router's module). */
  locals?: string[];
  kind: "static" | "dynamic" | "require" | "reexport";
  typeOnly: boolean;
  line: number;
}

export interface RouteFact {
  method: HttpMethod;
  path: string;
  line: number;
  framework: "express-like" | "next-app" | "next-pages";
  /** Names of the middleware / options passed alongside the handler (e.g. ["authLimiter", "requireAuth"]). */
  middleware: string[];
  /** The handler by name (`login`, `authController.login`), when it's defined elsewhere. */
  handler?: string;
  /** What an inline handler (`(req, res) => {...}`) does, in order. */
  handlerCalls?: FlowCall[];
}

/**
 * One notable thing a function does, in source order: the raw material for a
 * request flow ("reads email from the body -> looks up the user -> checks the
 * password -> sends 200").
 */
export type FlowCallKind = "input" | "validate" | "call" | "database" | "external" | "security" | "response" | "error";

export interface FlowCall {
  kind: FlowCallKind;
  /** As written in the code: `prisma.user.findUnique`, `bcrypt.compare`, `findUser`. */
  label: string;
  line: number;
  /** For "input": the fields read (`email`, `password`). */
  fields?: string[];
  /** For "input": body / query / params / headers / cookies. */
  source?: string;
  /** For "response": the HTTP status, when it's a literal. */
  status?: number;
  /** For "external": the host, when the URL is a literal. */
  host?: string;
}

/** A named function in a file and what it does. Names: `login`, `UserService.login`, `controller.login`. */
export interface FunctionFacts {
  name: string;
  line: number;
  calls: FlowCall[];
}

export interface MiddlewareUseFact {
  /** Path prefix the middleware is mounted on, if any. */
  path?: string;
  names: string[];
  /** Modules mounted inline: `router.use("/articles", require("./articles"))`. */
  requires?: string[];
  line: number;
}

/** Everything the atlas needs from one source file. Cached by git blob id, so each file version is parsed once. */
export interface FileFacts {
  path: string;
  loc: number;
  imports: ImportFact[];
  exports: string[];
  /** `export * from` present: named-export checks against this module are skipped. */
  exportsStar: boolean;
  routes: RouteFact[];
  middlewareUses: MiddlewareUseFact[];
  functions: number;
  isTest: boolean;
  /** Local routers composed from others: `const api = Router().use(users).use(articles)` -> { api: ["users", "articles"] }. */
  routerAliases?: Record<string, string[]>;
  /** Named functions and what they call, for following a request through the code. */
  functionFacts?: FunctionFacts[];
}

export type NodeKind = "module" | "route" | "package";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  file?: string;
  line?: number;
  loc?: number;
  /** Top-level directory (or package scope) used to cluster the map. */
  group: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "import" | "handles";
  /** Import that no longer resolves / names an export that doesn't exist. */
  broken?: boolean;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type FindingKind =
  | "auth-route-no-rate-limit"
  | "broken-import"
  | "broken-reference"
  | "import-cycle"
  | "unused-module"
  | "route-removed"
  | "no-tests";

export interface AtlasFinding {
  /** Stable across commits, so a finding can be tracked from the commit that introduced it to the one that fixed it. */
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  nodeId?: string;
}

export interface GraphMetrics {
  modules: number;
  testModules: number;
  loc: number;
  importEdges: number;
  packages: number;
  routes: number;
  authRoutes: number;
  unprotectedAuthRoutes: number;
  brokenImports: number;
  unusedModules: number;
  cycles: number;
}

export interface RepoGraph {
  commit?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  findings: AtlasFinding[];
  metrics: GraphMetrics;
}

export interface GraphDiff {
  from?: string;
  to?: string;
  addedNodes: GraphNode[];
  removedNodes: GraphNode[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
  /** Findings present after but not before: things this change broke or introduced. */
  newFindings: AtlasFinding[];
  resolvedFindings: AtlasFinding[];
  metricsDelta: Partial<Record<keyof GraphMetrics, number>>;
}

export interface CommitPoint {
  sha: string;
  author: string;
  date: string;
  subject: string;
  metrics: GraphMetrics;
  churn: { added: number; deleted: number; files: number };
  /** Lines deleted in this commit that had been added within the previous few commits. */
  shortLivedLines: number;
  shortLivedChars: number;
  delta: {
    modulesAdded: number;
    modulesRemoved: number;
    edgesAdded: number;
    edgesRemoved: number;
    newFindings: string[];
    resolvedFindings: string[];
  };
}

export interface Recommendation {
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  files?: string[];
  commit?: string;
}

export interface Hotspot {
  file: string;
  commits: number;
  churn: number;
  loc: number;
}

export interface HistoryAnalysis {
  repo?: string;
  ref: string;
  commits: CommitPoint[];
  head: RepoGraph;
  hotspots: Hotspot[];
  waste: {
    shortLivedLines: number;
    addedLines: number;
    /** Rough LLM-token equivalent of code that was written and thrown away (chars / 4). */
    estimatedTokens: number;
    windowCommits: number;
  };
  recommendations: Recommendation[];
  analyzedFiles: number;
  truncated: boolean;
}

/** A step in the life of one request, in plain words. */
export type FlowStepKind =
  | "client"
  | "middleware"
  | "missing"
  | "handler"
  | "input"
  | "validate"
  | "call"
  | "database"
  | "external"
  | "security"
  | "response"
  | "error";

export interface FlowStep {
  /** Stable across versions (kind + what it is + nesting), so two versions of a flow can be diffed. */
  key: string;
  kind: FlowStepKind;
  /** Short: "Checks the password". */
  title: string;
  /** One sentence a non-author can follow: "bcrypt.compare compares the password sent with the stored hash". */
  explain: string;
  /** The code behind it: `bcrypt.compare`. */
  code?: string;
  file?: string;
  line?: number;
  /** 0 = in the handler; 1+ = inside a function the handler called. */
  depth: number;
  /** For "missing" steps. */
  severity?: FindingSeverity;
}

export interface RequestFlow {
  routeId: string;
  method: HttpMethod;
  path: string;
  file: string;
  line: number;
  steps: FlowStep[];
}

export interface FlowStepChange extends FlowStep {
  change: "added" | "removed" | "same";
}

export interface FlowDiff {
  routeId: string;
  label: string;
  status: "added" | "removed" | "changed" | "same";
  steps: FlowStepChange[];
  /** "Adds a rate limiter; no longer checks the password". */
  summary: string;
}
