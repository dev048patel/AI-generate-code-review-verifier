// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { apiUrl, atlasUrl, normalizeServer, parseGithubUrl, renderPanel, type PrImpact } from "./lib.js";

describe("parseGithubUrl", () => {
  it("recognizes repos and pull requests, and nothing else", () => {
    expect(parseGithubUrl("https://github.com/acme/api/pull/42/files")).toEqual({ owner: "acme", repo: "api", pr: 42 });
    expect(parseGithubUrl("https://github.com/acme/api")).toEqual({ owner: "acme", repo: "api" });
    expect(parseGithubUrl("https://github.com/settings/profile")).toBeUndefined();
    expect(parseGithubUrl("https://github.com/acme")).toBeUndefined();
    expect(parseGithubUrl("https://evil.com/acme/api/pull/1")).toBeUndefined();
  });
});

describe("urls", () => {
  it("builds dashboard and API links", () => {
    expect(atlasUrl("https://acrv.example.com", { owner: "acme", repo: "api", pr: 7 })).toBe(
      "https://acrv.example.com/atlas?repo=acme%2Fapi&tab=compare&pr=7",
    );
    expect(apiUrl("http://localhost:3001", { owner: "acme", repo: "api", pr: 7 })).toBe("http://localhost:3001/api/atlas/acme/api/pulls/7");
  });

  it("only accepts https servers (http for localhost)", () => {
    expect(normalizeServer("https://acrv.example.com/some/path")).toBe("https://acrv.example.com");
    expect(normalizeServer("http://localhost:3001")).toBe("http://localhost:3001");
    expect(normalizeServer("http://acrv.example.com")).toBeUndefined();
    expect(normalizeServer("javascript:alert(1)")).toBeUndefined();
  });
});

describe("renderPanel", () => {
  const impact: PrImpact = {
    summary: "1 route(s) added, 0 removed; 1 new high-severity problem(s).",
    diff: {
      newFindings: [{ severity: "high", title: '<img src=x onerror="alert(1)"> POST /login has no rate limiting', file: "src/app.ts", line: 3 }],
      resolvedFindings: [],
      addedNodes: [{ kind: "route", label: "POST /login" }],
      removedNodes: [],
    },
    flows: [{ label: "POST /login", status: "changed", summary: "⚠ now: no rate limiter; − checks the password" }],
    architecture: { summary: ["⚠ now: no rate limiter", "− Rate limiter"] },
  };

  it("shows the change and links to the full map", () => {
    const panel = renderPanel(document, impact, "https://acrv.example.com/atlas?repo=acme%2Fapi");
    expect(panel.textContent).toContain("1 new high-severity problem");
    expect(panel.textContent).toContain("New routes: POST /login");
    expect(panel.textContent).toContain("How requests change (1):");
    expect(panel.textContent).toContain("Architecture: ⚠ now: no rate limiter · − Rate limiter");
    expect([...panel.querySelectorAll("li")].map((li) => li.textContent)).toContain("POST /login: ⚠ now: no rate limiter; − checks the password");
    expect(panel.querySelector("a")!.getAttribute("href")).toBe("https://acrv.example.com/atlas?repo=acme%2Fapi");
    expect(panel.querySelector("a")!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("never interprets repo-controlled text as HTML", () => {
    const panel = renderPanel(document, impact, "https://x");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
