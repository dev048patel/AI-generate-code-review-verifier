import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Architecture } from "../../atlasTypes";
import { ArchDiagram } from "./ArchDiagram";
import { edgeText, layoutArchitecture, NODE_W, pointAlong } from "./archLayout";

const arch: Architecture = {
  components: [
    { id: "client", type: "client", zone: "clients", label: "Clients", sublabel: "browser · app · script", sources: [], routes: ["r:POST /login", "r:GET /posts"] },
    { id: "mw:pipeline", type: "middleware", zone: "middleware", label: "Middleware", sublabel: "CORS · body parser", sources: [{ file: "src/app.ts", line: 5 }], routes: ["r:POST /login", "r:GET /posts"] },
    { id: "gap:rate-limit", type: "gap", zone: "checks", label: "No rate limiter", tag: "missing", sources: [], routes: ["r:POST /login"] },
    { id: "mw:sign-in-check", type: "security", zone: "checks", label: "Sign-in check", sublabel: "requireAuth", sources: [{ file: "src/auth.ts", line: 3 }], routes: ["r:GET /posts"] },
    { id: "code:src/auth.controller.ts", type: "backend", zone: "routes", label: "Auth controller", tag: "1 route", sources: [{ file: "src/auth.controller.ts", line: 2, label: "login()" }], routes: ["r:POST /login"] },
    { id: "code:src/posts.controller.ts", type: "backend", zone: "routes", label: "Posts controller", tag: "1 route", sources: [], routes: ["r:GET /posts"] },
    { id: "db:main", type: "database", zone: "data", label: "Database", sublabel: "user · post", sources: [], routes: ["r:POST /login", "r:GET /posts"] },
    { id: "sec:passwords", type: "security", zone: "data", label: "Password hashing", sublabel: "bcrypt", sources: [], routes: ["r:POST /login"] },
  ],
  edges: [
    { id: "client>mw:pipeline", from: "client", to: "mw:pipeline", labels: ["POST /login", "GET /posts"], kind: "request", routes: ["r:POST /login", "r:GET /posts"] },
    { id: "mw:pipeline>gap:rate-limit", from: "mw:pipeline", to: "gap:rate-limit", labels: ["POST /login"], kind: "request", routes: ["r:POST /login"] },
    { id: "gap:rate-limit>code:src/auth.controller.ts", from: "gap:rate-limit", to: "code:src/auth.controller.ts", labels: ["POST /login"], kind: "request", routes: ["r:POST /login"] },
    { id: "mw:pipeline>mw:sign-in-check", from: "mw:pipeline", to: "mw:sign-in-check", labels: ["GET /posts"], kind: "request", routes: ["r:GET /posts"] },
    { id: "mw:sign-in-check>code:src/posts.controller.ts", from: "mw:sign-in-check", to: "code:src/posts.controller.ts", labels: ["GET /posts"], kind: "request", routes: ["r:GET /posts"] },
    { id: "code:src/auth.controller.ts>db:main", from: "code:src/auth.controller.ts", to: "db:main", labels: ["read user"], kind: "data", routes: ["r:POST /login"] },
    { id: "code:src/auth.controller.ts>sec:passwords", from: "code:src/auth.controller.ts", to: "sec:passwords", labels: ["bcrypt.compare"], kind: "call", routes: ["r:POST /login"] },
    { id: "code:src/posts.controller.ts>db:main", from: "code:src/posts.controller.ts", to: "db:main", labels: ["read post"], kind: "data", routes: ["r:GET /posts"] },
  ],
  stories: [
    {
      id: "post-login",
      routeId: "r:POST /login",
      label: "POST /login",
      title: "Logs a user in: no rate limiter",
      severity: "high",
      components: ["client", "mw:pipeline", "gap:rate-limit", "code:src/auth.controller.ts", "db:main", "sec:passwords"],
      hops: [
        { from: "client", to: "mw:pipeline", label: "POST /login", kind: "request", note: "Reads the request body", stepKey: "a" },
        { from: "mw:pipeline", to: "gap:rate-limit", label: "POST /login", kind: "gap", note: "⚠ No rate limiter: anyone can guess passwords", stepKey: "b" },
        { from: "gap:rate-limit", to: "code:src/auth.controller.ts", label: "POST /login", kind: "request", note: "Runs login()", stepKey: "c" },
        { from: "code:src/auth.controller.ts", to: "db:main", label: "read user", kind: "data", note: "Looks up user in the database", stepKey: "d" },
        { from: "code:src/auth.controller.ts", to: "sec:passwords", label: "bcrypt.compare", kind: "call", note: "Checks the password", stepKey: "e" },
        { from: "code:src/auth.controller.ts", to: "client", label: "200 OK", kind: "return", note: "Sends back 200 OK", stepKey: "f" },
      ],
    },
    {
      id: "get-posts",
      routeId: "r:GET /posts",
      label: "GET /posts",
      title: "Reads data",
      components: ["client", "mw:pipeline", "mw:sign-in-check", "code:src/posts.controller.ts", "db:main"],
      hops: [
        { from: "client", to: "mw:pipeline", label: "GET /posts", kind: "request", note: "…", stepKey: "a" },
        { from: "mw:pipeline", to: "mw:sign-in-check", label: "GET /posts", kind: "request", note: "…", stepKey: "b" },
      ],
    },
  ],
};

describe("layoutArchitecture", () => {
  it("puts zones left to right in request order, with boxes inside their zone", () => {
    const l = layoutArchitecture(arch.components, arch.edges);
    expect(l.zones.map((z) => z.label)).toEqual(["Clients", "Middleware", "Checks before your code", "Route handlers", "Data & integrations"]);
    const x = (id: string) => l.nodes.get(id)!.x;
    expect(x("client")).toBeLessThan(x("mw:pipeline"));
    expect(x("mw:pipeline")).toBeLessThan(x("gap:rate-limit"));
    expect(x("gap:rate-limit")).toBe(x("mw:sign-in-check"));
    expect(x("code:src/auth.controller.ts")).toBeLessThan(x("db:main"));
    for (const z of l.zones) {
      for (const c of arch.components.filter((c) => c.zone === z.id)) {
        const b = l.nodes.get(c.id)!;
        expect(b.x).toBeGreaterThanOrEqual(z.box.x);
        expect(b.x + NODE_W).toBeLessThanOrEqual(z.box.x + z.box.w);
      }
    }
  });

  it("keeps connected boxes level, so arrows don't cross", () => {
    const l = layoutArchitecture(arch.components, arch.edges);
    const y = (id: string) => l.nodes.get(id)!.y;
    // gap -> auth controller and sign-in -> posts controller: same vertical order on both sides.
    expect(Math.sign(y("gap:rate-limit") - y("mw:sign-in-check"))).toBe(Math.sign(y("code:src/auth.controller.ts") - y("code:src/posts.controller.ts")));
  });

  it("routes right-angled arrows from box to box, with non-overlapping labels", () => {
    const l = layoutArchitecture(arch.components, arch.edges);
    const r = l.edges.get("client>mw:pipeline")!;
    const [sx] = r.points[0]!;
    const [tx] = r.points[r.points.length - 1]!;
    expect(sx).toBe(l.nodes.get("client")!.x + NODE_W);
    expect(tx).toBe(l.nodes.get("mw:pipeline")!.x);
    expect(r.points.every((p, i) => i === 0 || p[0] === r.points[i - 1]![0] || p[1] === r.points[i - 1]![1])).toBe(true);
    const labels = [...l.edges.values()].flatMap((e) => (e.label ? [e.label] : []));
    for (const a of labels) for (const b of labels) if (a !== b) expect(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= 18).toBe(true);
    expect(edgeText({ labels: ["POST /login", "GET /posts"] })).toBe("POST /login +1");
  });

  it("finds points along an arrow for the moving dot", () => {
    expect(pointAlong([[0, 0], [10, 0], [10, 10]], 0.5)).toEqual([10, 0]);
    expect(pointAlong([[0, 0], [10, 0], [10, 10]], 1)).toEqual([10, 10]);
  });
});

describe("ArchDiagram", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("draws every part with its role, and the missing safeguard as a box", () => {
    render(<ArchDiagram data={arch} title="acme/api" />);
    expect(screen.getAllByTestId("arch-node")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Missing safeguard: No rate limiter, missing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Database: Database (user · post)" })).toBeInTheDocument();
    expect(screen.getAllByTestId("arch-edge")).toHaveLength(8);
  });

  it("plays a story: its path lights up hop by hop and the rest dims", () => {
    vi.useFakeTimers();
    render(<ArchDiagram data={arch} title="acme/api" />);
    fireEvent.click(screen.getByRole("button", { name: /POST \/login/ }));
    expect(screen.getByText(/6 hops/)).toBeInTheDocument();
    const node = (id: string) => screen.getAllByTestId("arch-node").find((n) => n.getAttribute("data-id") === id)!;
    expect(node("mw:sign-in-check").getAttribute("opacity")).toBe("0.16"); // not on the login path
    expect(node("gap:rate-limit").getAttribute("opacity")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "▶ Play story" }));
    act(() => vi.advanceTimersByTime(0));
    act(() => vi.advanceTimersByTime(1300));
    expect(screen.getByText("2 / 6")).toBeInTheDocument();
    expect(screen.getByText(/No rate limiter: anyone can guess passwords/)).toBeInTheDocument();
    expect(node("code:src/auth.controller.ts").getAttribute("opacity")).toBe("0.16"); // not reached yet
    expect(screen.getByTestId("hop-dot")).toBeInTheDocument();
    for (let i = 0; i < 4; i++) act(() => vi.advanceTimersByTime(1300));
    expect(screen.getByText("6 / 6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "▶ Play story" })).toBeInTheDocument(); // stopped at the end
  });

  it("shows the same story as a sequence, one arrow per hop in order", () => {
    render(<ArchDiagram data={arch} title="acme/api" />);
    fireEvent.click(screen.getByRole("button", { name: /POST \/login/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sequence" }));
    expect(screen.getAllByTestId("seq-participant").map((p) => p.textContent)).toEqual([
      "💻 Clientsbrowser · app · script",
      "⚙ MiddlewareCORS · body parser",
      "⚠ No rate limiter",
      "⟨⟩ Auth controller",
      "🗄 Databaseuser · post",
      "🔒 Password hashingbcrypt",
    ]);
    const hops = screen.getAllByTestId("seq-hop");
    expect(hops.map((h) => within(h).getAllByText(/./)[0]!.textContent)).toEqual(["POST /login", "⚠ POST /login", "POST /login", "read user", "bcrypt.compare", "200 OK"]);
    fireEvent.click(screen.getByRole("button", { name: "Next hop" }));
    fireEvent.click(screen.getByRole("button", { name: "Next hop" }));
    expect(hops[1]!.getAttribute("data-state")).toBe("current");
    expect(hops[4]!.getAttribute("data-state")).toBe("later");
  });

  it("opens a box's details: where it is in the code and which requests pass through", () => {
    render(<ArchDiagram data={arch} title="acme/api" />);
    fireEvent.click(screen.getByRole("button", { name: /Route handlers: Auth controller/ }));
    const panel = screen.getByLabelText("Details for Auth controller");
    expect(panel.textContent).toContain("src/auth.controller.ts:2");
    expect(panel.textContent).toContain("→ Database: read user");
    fireEvent.click(within(panel).getByRole("button", { name: "POST /login" }));
    expect(screen.getByText(/6 hops/)).toBeInTheDocument();
  });

  it("filters to one kind of part from the legend", () => {
    render(<ArchDiagram data={arch} title="acme/api" />);
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const node = (id: string) => screen.getAllByTestId("arch-node").find((n) => n.getAttribute("data-id") === id)!;
    expect(node("db:main").getAttribute("opacity")).toBe("1");
    expect(node("code:src/posts.controller.ts").getAttribute("opacity")).toBe("1"); // connected to it
    expect(node("gap:rate-limit").getAttribute("opacity")).toBe("0.16");
  });

  it("opens the view a shared link points at, and keeps the link current", () => {
    window.history.replaceState(null, "", "/atlas?repo=acme/api#story=post-login&mode=sequence&step=3");
    render(<ArchDiagram data={arch} title="acme/api" shareable />);
    expect(screen.getByRole("button", { name: "Sequence" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("3 / 6")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next hop" }));
    expect(window.location.hash).toBe("#story=post-login&mode=sequence&step=4");
    expect(window.location.search).toBe("?repo=acme/api");
  });

  it("marks what a change added and removed", () => {
    const diff = {
      components: arch.components.map((c) => ({ ...c, status: c.id === "gap:rate-limit" ? ("removed" as const) : c.id === "sec:passwords" ? ("added" as const) : ("same" as const) })),
      edges: arch.edges.map((e) => ({ ...e, status: "same" as const })),
      stories: [],
    };
    render(<ArchDiagram data={diff} title="a → b" summary={["fixed: no rate limiter", "+ Password hashing"]} />);
    expect(screen.getByLabelText("What this change did to the architecture").textContent).toBe("fixed: no rate limiter+ Password hashing");
    expect(screen.getByRole("button", { name: "Missing safeguard: No rate limiter, removed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Security: Password hashing (bcrypt), new" })).toBeInTheDocument();
  });
});
