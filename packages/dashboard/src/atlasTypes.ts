/** Mirrors @acrv/atlas's wire types (the dashboard doesn't import server-side packages). */

export type NodeKind = "module" | "route" | "package";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  file?: string;
  line?: number;
  loc?: number;
  group: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "import" | "handles";
  broken?: boolean;
}

export interface AtlasFinding {
  id: string;
  kind: string;
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
  shortLivedLines: number;
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

export interface HistoryAnalysis {
  repo?: string;
  commits: CommitPoint[];
  head: RepoGraph;
  hotspots: Array<{ file: string; commits: number; churn: number; loc: number }>;
  waste: { shortLivedLines: number; addedLines: number; estimatedTokens: number; windowCommits: number };
  recommendations: Recommendation[];
  truncated: boolean;
}

export interface AtlasJob {
  repo: string;
  status: "running" | "done" | "failed";
  progress: { done: number; total: number };
  error?: string;
}

export interface CompareResult {
  before: RepoGraph;
  after: RepoGraph;
  diff: GraphDiff;
  /** Requests whose path through the code changed. */
  flows: FlowDiff[];
  /** Both versions' architecture on one diagram. */
  architecture: ArchitectureDiff;
  summary: string;
}

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
  key: string;
  kind: FlowStepKind;
  title: string;
  explain: string;
  code?: string;
  file?: string;
  line?: number;
  depth: number;
  severity?: AtlasFinding["severity"];
}

export interface RequestFlow {
  routeId: string;
  method: string;
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
  summary: string;
}

export interface RuntimeNode {
  id: string;
  kind: "route" | "external" | "database" | "internal" | "service";
  label: string;
  calls: number;
  errors: number;
}

export interface RuntimeEdge {
  from: string;
  to: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
}

export interface RuntimeView {
  snapshot: { nodes: RuntimeNode[]; edges: RuntimeEdge[]; spans: number };
  coverage?: { neverCalled: string[]; unknownAtRuntime: string[]; slowest: RuntimeEdge[]; failing: RuntimeEdge[] };
}

export type ArchType = "client" | "security" | "gap" | "middleware" | "backend" | "service" | "database" | "cache" | "external";
export type ArchZone = "clients" | "middleware" | "checks" | "routes" | "services" | "data";

export interface ArchComponent {
  id: string;
  type: ArchType;
  zone: ArchZone;
  label: string;
  sublabel?: string;
  tag?: string;
  sources: Array<{ file: string; line?: number; label?: string }>;
  routes: string[];
}

export interface ArchEdge {
  id: string;
  from: string;
  to: string;
  labels: string[];
  kind: "request" | "call" | "data";
  routes: string[];
}

export interface ArchHop {
  from: string;
  to: string;
  label: string;
  kind: "request" | "call" | "data" | "return" | "gap";
  note: string;
  stepKey: string;
}

export interface ArchStory {
  id: string;
  routeId: string;
  label: string;
  title: string;
  severity?: AtlasFinding["severity"];
  hops: ArchHop[];
  components: string[];
}

export interface Architecture {
  components: ArchComponent[];
  edges: ArchEdge[];
  stories: ArchStory[];
}

export type ArchStatus = "added" | "removed" | "same";

export interface ArchitectureDiff {
  components: Array<ArchComponent & { status: ArchStatus }>;
  edges: Array<ArchEdge & { status: ArchStatus }>;
  summary: string[];
}
