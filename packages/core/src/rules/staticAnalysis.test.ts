import { describe, expect, it } from "vitest";
import { parseDiff } from "../diff/parseDiff.js";
import { runStaticAnalysis } from "./staticAnalysis.js";

function analyze(diffText: string) {
  const parsed = parseDiff(diffText);
  return parsed.files.flatMap((f) => runStaticAnalysis(f));
}

describe("runStaticAnalysis", () => {
  it("flags a removed null guard", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,3 @@
 function f(x) {
-  if (x === null) return;
   doStuff(x);
 }
`);
    expect(findings.some((f) => f.title.includes("Null/undefined guard"))).toBe(true);
  });

  it("flags a comparison operator change", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 function f(i, arr) {
-  return i < arr.length;
+  return i <= arr.length;
 }
`);
    expect(findings.some((f) => f.title.includes("Comparison operator changed"))).toBe(true);
  });

  it("flags a boolean operator swap", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 function f(a, b) {
-  return a && b;
+  return a || b;
 }
`);
    expect(findings.some((f) => f.title.includes("Boolean operator swapped"))).toBe(true);
  });

  it("flags removed await", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 async function f() {
-  await save();
+  save();
 }
`);
    expect(findings.some((f) => f.title.includes("await"))).toBe(true);
  });

  it("flags an empty catch block", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,5 @@
 function f() {
+  try { risky(); } catch (e) {}
 }
`);
    expect(findings.some((f) => f.title.includes("Empty catch"))).toBe(true);
  });

  it("flags SQL string concatenation", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 function q(id) {
+  return db.query("SELECT * FROM users WHERE id = " + id);
 }
`);
    expect(findings.some((f) => f.title.includes("SQL injection"))).toBe(true);
  });

  it("flags a boolean negation removed", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 function validate(x) {
-  return !isValid(x);
+  return isValid(x);
 }
`);
    expect(findings.some((f) => f.title.includes("negation"))).toBe(true);
  });

  it("flags SQL concatenation with mixed quote styles (single-quoted literal inside a double-quoted string)", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 function q(name) {
+  return db.query("SELECT * FROM users WHERE name = '" + name + "'");
 }
`);
    expect(findings.some((f) => f.title.includes("SQL injection"))).toBe(true);
  });

  it("does not flag clean, unrelated additions", () => {
    const findings = analyze(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 function f() {
+  const y = compute();
 }
`);
    expect(findings).toHaveLength(0);
  });
});
