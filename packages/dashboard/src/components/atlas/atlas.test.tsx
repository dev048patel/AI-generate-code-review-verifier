import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CommitPoint, FlowDiff, HistoryAnalysis, RepoGraph, RequestFlow } from "../../atlasTypes";
import { Atlas } from "../../pages/Atlas";
import { cappedMax } from "./Charts";
import { FlowChanges, FlowPlayer } from "./RequestFlow";
import { COLLAPSE_THRESHOLD, columnOf, layoutGraph, toDiffMaps, toMap } from "./layout";

const metrics = { modules: 2, testModules: 0, loc: 20, importEdges: 1, packages: 1, routes: 1, authRoutes: 1, unprotectedAuthRoutes: 1, brokenImports: 0, unusedModules: 0, cycles: 0 };

const graph: RepoGraph = {
  commit: "b".repeat(40),
  nodes: [
    { id: "m:src/app.ts", kind: "module", label: "app.ts", file: "src/app.ts", loc: 12, group: "src" },
    { id: "m:src/db.ts", kind: "module", label: "db.ts", file: "src/db.ts", loc: 8, group: "src" },
    { id: "r:POST /login", kind: "route", label: "POST /login", file: "src/app.ts", group: "routes" },
    { id: "p:pg", kind: "package", label: "pg", group: "packages" },
  ],
  edges: [
    { from: "r:POST /login", to: "m:src/app.ts", kind: "handles" },
    { from: "m:src/app.ts", to: "m:src/db.ts", kind: "import" },
    { from: "m:src/db.ts", to: "p:pg", kind: "import" },
  ],
  findings: [
    { id: "auth-route-no-rate-limit:POST /login", kind: "auth-route-no-rate-limit", severity: "high", title: "POST /login has no rate limiting", detail: "…", nodeId: "r:POST /login" },
  ],
  metrics,
};

function commit(sha: string, subject: string, extra: Partial<CommitPoint> = {}): CommitPoint {
  return {
    sha: sha.repeat(40).slice(0, 40),
    author: "a",
    date: "2026-01-01",
    subject,
    metrics,
    churn: { added: 10, deleted: 2, files: 1 },
    shortLivedLines: 1,
    delta: { modulesAdded: 0, modulesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, newFindings: [], resolvedFindings: [] },
    ...extra,
  };
}

const analysis: HistoryAnalysis = {
  repo: "acme/api",
  commits: [commit("a", "init"), commit("b", "drop limiter", { delta: { modulesAdded: 0, modulesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, newFindings: ["auth-route-no-rate-limit:POST /login"], resolvedFindings: [] } })],
  head: graph,
  hotspots: [{ file: "src/app.ts", commits: 2, churn: 12, loc: 12 }],
  waste: { shortLivedLines: 1, addedLines: 10, estimatedTokens: 12, windowCommits: 5 },
  recommendations: [{ id: "r1", priority: "high", title: "Add rate limiting to POST /login", detail: "Add a limiter." }],
  truncated: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("layout", () => {
  it("puts routes left, packages right and code in the middle, deterministically", () => {
    const m = toMap(graph);
    const a = layoutGraph(m.nodes, m.edges, { width: 960, height: 560 });
    const b = layoutGraph(m.nodes, m.edges, { width: 960, height: 560 });
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.get("r:POST /login")!.x).toBeLessThan(a.get("m:src/app.ts")!.x);
    expect(a.get("m:src/app.ts")!.x).toBeLessThan(a.get("p:pg")!.x);
    expect(columnOf("database")).toBe("right");
  });

  it("carries findings onto map nodes", () => {
    expect(toMap(graph).nodes.find((n) => n.id === "r:POST /login")).toMatchObject({ severity: "high", findings: ["POST /login has no rate limiting"] });
  });

  it("collapses big repos into directories", () => {
    const nodes = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) => ({
      id: `m:pkg${i % 3}/f${i}.ts`,
      kind: "module" as const,
      label: `f${i}.ts`,
      file: `pkg${i % 3}/f${i}.ts`,
      loc: 1,
      group: `pkg${i % 3}`,
    }));
    const m = toMap({ ...graph, nodes, edges: [{ from: nodes[0]!.id, to: nodes[1]!.id, kind: "import" }], findings: [] });
    expect(m.nodes.map((n) => n.id).sort()).toEqual(["g:pkg0", "g:pkg1", "g:pkg2"]);
    expect(m.edges).toEqual([{ from: "g:pkg0", to: "g:pkg1", weight: 1 }]);
  });

  it("marks added, removed and broken nodes on a shared before/after layout", () => {
    const after: RepoGraph = {
      ...graph,
      nodes: [...graph.nodes.filter((n) => n.id !== "m:src/db.ts"), { id: "m:src/cache.ts", kind: "module", label: "cache.ts", group: "src" }],
    };
    const d = toDiffMaps(graph, after, {
      addedNodes: [],
      removedNodes: [],
      addedEdges: [],
      removedEdges: [],
      newFindings: [{ ...graph.findings[0]!, nodeId: "m:src/app.ts" }],
      resolvedFindings: [],
      metricsDelta: {},
    });
    const status = (list: typeof d.after.nodes, id: string) => list.find((n) => n.id === id)?.status;
    expect(status(d.before.nodes, "m:src/db.ts")).toBe("removed");
    expect(status(d.after.nodes, "m:src/cache.ts")).toBe("added");
    expect(status(d.after.nodes, "m:src/app.ts")).toBe("broken");
    expect(d.union.nodes).toHaveLength(5);
  });
});

describe("cappedMax", () => {
  it("ignores one giant outlier so ordinary commits stay visible", () => {
    expect(cappedMax([10, 12, 8, 15, 9, 11, 2400])).toBe(30);
    expect(cappedMax([10, 12, 8, 15, 9])).toBe(20);
  });
});

const step = (kind: RequestFlow["steps"][number]["kind"], title: string, extra: Partial<RequestFlow["steps"][number]> = {}) => ({
  key: `${kind}:${title}`,
  kind,
  title,
  explain: `${title}, explained.`,
  depth: 0,
  ...extra,
});

const loginFlow: RequestFlow = {
  routeId: "r:POST /login",
  method: "POST",
  path: "/login",
  file: "src/app.ts",
  line: 3,
  steps: [
    step("client", "Client sends POST /login"),
    step("missing", "No rate limiter", { severity: "high" }),
    step("handler", "Runs login()", { file: "src/auth.ts", line: 4 }),
    step("database", "Looks up user in the database", { code: "prisma.user.findUnique", depth: 1 }),
    step("security", "Checks the password", { code: "bcrypt.compare", depth: 1 }),
    step("response", "Sends back 200 OK"),
  ],
};

describe("request flows", () => {
  afterEach(() => vi.useRealTimers());

  it("lists the steps in order, with the gap where the safeguard should be", () => {
    render(<FlowPlayer flow={loginFlow} />);
    const rows = screen.getAllByTestId("flow-step");
    expect(rows.map((r) => r.querySelector(".flow-title")!.textContent)).toEqual([
      "💻Client sends POST /login",
      "⚠️No rate limiter",
      "⚙️Runs login()",
      "🗄️Looks up user in the databaseprisma.user.findUnique",
      "🔑Checks the passwordbcrypt.compare",
      "📤Sends back 200 OK",
    ]);
    expect(rows[1]!.className).toContain("sev-high");
    expect(rows[3]!.style.marginLeft).toBe("28px"); // inside login()
    expect(screen.getByText("⚠ 1 to fix", { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText("Parts this request passes through").textContent).toBe(
      "Client→⚠ Checks→Your code→Database→Passwords & tokens→Response",
    );
  });

  it("plays the request through step by step", () => {
    vi.useFakeTimers();
    render(<FlowPlayer flow={loginFlow} />);
    fireEvent.click(screen.getByRole("button", { name: "▶ Play request" }));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByText("Step 1 of 6:", { exact: false })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1100));
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getByText("Step 3 of 6:", { exact: false }).parentElement!.textContent).toContain("Runs login()");
    expect(screen.getAllByTestId("flow-step")[2]!.className).toContain("active");
    expect(screen.getAllByTestId("flow-step")[1]!.className).toContain("done");
    fireEvent.click(screen.getByRole("button", { name: "⏸ Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText("Step 4 of 6:", { exact: false })).toBeInTheDocument();
  });

  it("shows what a change did to a request: added steps and removed ones", () => {
    const diff: FlowDiff = {
      routeId: "r:POST /login",
      label: "POST /login",
      status: "changed",
      summary: "− checks the password",
      steps: [
        { ...loginFlow.steps[0]!, change: "same" },
        { ...step("middleware", "Rate limiter"), change: "added" },
        { ...loginFlow.steps[4]!, change: "removed" },
        { ...loginFlow.steps[5]!, change: "same" },
      ],
    };
    render(<FlowChanges flows={[diff]} />);
    expect(screen.getByText("− checks the password")).toBeInTheDocument();
    const rows = screen.getAllByTestId("flow-step");
    expect(rows.map((r) => r.querySelector(".flow-dot")!.textContent)).toEqual(["1", "+", "−", "3"]);
    expect(rows[2]!.className).toContain("chg-removed");
    fireEvent.click(screen.getByRole("button", { name: /POST \/login/ }));
    expect(screen.queryAllByTestId("flow-step")).toHaveLength(0);
  });

  it("says so when nothing about the requests changed", () => {
    render(<FlowChanges flows={[]} />);
    expect(screen.getByText(/No request moves through the code differently/)).toBeInTheDocument();
  });
});

describe("Atlas page", () => {
  it("analyzes a repo and shows request flows, recommendations, charts and the map", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/atlas/acme/api/architecture")) return Response.json({ components: [], edges: [], stories: [] });
      if (url.startsWith("/api/atlas/acme/api/flows")) return Response.json([{ ...loginFlow, routeId: "r:GET /health", method: "GET", path: "/health", steps: loginFlow.steps.slice(0, 1) }, loginFlow]);
      if (url === "/api/atlas/analyze") return Response.json({ job: { repo: "acme/api", status: "running", progress: { done: 0, total: 2 } } });
      return Response.json({ job: { repo: "acme/api", status: "done", progress: { done: 2, total: 2 } }, analysis });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter>
        <Atlas />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/acme/api" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    // Opens on the diagram (nothing to draw here: no routes in the mock), then the request flow.
    expect(await screen.findByText(/No HTTP routes found, so there's no request path to draw/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request flow" }));
    await waitFor(() => expect(screen.getByText("Looks up user in the database")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /GET \/health/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(screen.getByText("Add rate limiting to POST /login")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/atlas/analyze", expect.objectContaining({ body: JSON.stringify({ repo: "acme/api", maxCommits: 150 }) }));
    expect(screen.getAllByText("drop limiter", { exact: false }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(screen.getByRole("img", { name: /Dependency map/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /HTTP route POST \/login, 1 finding/ })).toBeInTheDocument();
  });

  it("rejects input that isn't owner/name", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <MemoryRouter>
        <Atlas />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "not a repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText(/owner\/name/)).toBeInTheDocument();
  });
});
