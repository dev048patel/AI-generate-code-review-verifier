import path from "node:path";
import type { ChangedFunction, GeneratedTestFile, ParamInfo } from "@acrv/core";
import { inferArbitrary } from "./inferArbitraries.js";

export interface GenerateTestsOptions {
  /** Import specifier used in the generated test's `import` statement, e.g. "./pay". */
  importSpecifier: string;
}

/**
 * Generates two kinds of tests for a changed function, without needing a
 * correctness oracle (the reviewer doesn't know the "right" answer for
 * AI-generated code, only what the function currently does):
 *
 *  - Edge-case tests: call the function with boundary values one parameter
 *    at a time (0, negative, empty string, empty array, huge input, ...).
 *  - A property-based test (fast-check): call the function with hundreds of
 *    random inputs matching each parameter's type.
 *
 * Both kinds assert only type-level and no-throw invariants derived from the
 * function's own signature. That's intentionally weak as a correctness
 * oracle -- their real job is to give mutation testing something to run
 * against so we can measure whether *any* test would notice a behavior
 * change (see packages/mutation). A generated test failing is itself a
 * signal worth surfacing, not proof of a bug.
 */
export function generateTestsForFunction(
  fn: ChangedFunction,
  options: GenerateTestsOptions,
): GeneratedTestFile[] {
  if (!fn.isExported) return [];
  if (fn.params.length === 0 && fn.returnTypeText === null) return [];

  const specs = fn.params.map((p) => ({ param: p, spec: inferArbitrary(p.typeText) }));
  const anySupported = specs.some((s) => s.spec.supported);
  if (fn.params.length > 0 && !anySupported) return [];

  const files: GeneratedTestFile[] = [];
  const dir = path.dirname(fn.file);
  const slug = slugify(fn.name);
  const testFileName = path.join(dir, `${slug}.${fn.startLine}.acrv.gen.test.ts`);

  const edgeCaseContent = buildEdgeCaseTest(fn, specs, options.importSpecifier);
  files.push({
    targetFunctionId: fn.id,
    file: testFileName.replace(/\.acrv\.gen\.test\.ts$/, ".edge.acrv.gen.test.ts"),
    content: edgeCaseContent,
    kind: "edge-case",
  });

  if (anySupported) {
    const propertyContent = buildPropertyTest(fn, specs, options.importSpecifier);
    files.push({
      targetFunctionId: fn.id,
      file: testFileName.replace(/\.acrv\.gen\.test\.ts$/, ".property.acrv.gen.test.ts"),
      content: propertyContent,
      kind: "property",
    });
  }

  return files;
}

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function defaultValueLiteral(param: ParamInfo): string {
  const spec = inferArbitrary(param.typeText);
  if (spec.supported && spec.edgeCaseLiterals[0]) return spec.edgeCaseLiterals[1] ?? spec.edgeCaseLiterals[0];
  return "undefined";
}

function callExpr(fn: ChangedFunction, argLiterals: string[]): string {
  const args = argLiterals.join(", ");
  const call = `${fn.name}(${args})`;
  return fn.isAsync ? `await ${call}` : call;
}

function returnTypeAssertion(fn: ChangedFunction, resultVar: string): string | null {
  let t = (fn.returnTypeText ?? "").toLowerCase().trim();
  // The call site only unwraps a Promise when it actually awaits the call
  // (see callExpr), which only happens for `async` functions. A non-async
  // function typed to return a Promise still yields a Promise object.
  if (fn.isAsync) {
    t = t.replace(/^promise<(.+)>$/, "$1").trim();
  } else if (/^promise</.test(t)) {
    return null;
  }
  if (t === "number") return `expect(typeof ${resultVar}).toBe("number");`;
  if (t === "string") return `expect(typeof ${resultVar}).toBe("string");`;
  if (t === "boolean") return `expect(typeof ${resultVar}).toBe("boolean");`;
  if (/^\w+\[\]$/.test(t) || /^array<.+>$/.test(t)) return `expect(Array.isArray(${resultVar})).toBe(true);`;
  return null;
}

function buildEdgeCaseTest(
  fn: ChangedFunction,
  specs: { param: ParamInfo; spec: ReturnType<typeof inferArbitrary> }[],
  importSpecifier: string,
): string {
  const defaults = specs.map((s) => defaultValueLiteral(s.param));
  const cases: { title: string; args: string[] }[] = [];

  specs.forEach((s, idx) => {
    if (!s.spec.supported) return;
    for (const literal of s.spec.edgeCaseLiterals) {
      const args = [...defaults];
      args[idx] = literal;
      cases.push({ title: `${s.param.name} = ${literal}`, args });
    }
  });

  if (cases.length === 0) {
    cases.push({ title: "default arguments", args: defaults });
  }

  const asyncPrefix = fn.isAsync ? "async " : "";
  const testBodies = cases
    .map(({ title, args }) => {
      const assertion = returnTypeAssertion(fn, "result");
      return `  it(${JSON.stringify(title)}, ${asyncPrefix}() => {
    let threw = false;
    let result: unknown;
    try {
      result = ${callExpr(fn, args)};
    } catch (err) {
      threw = true;
    }
    // Generated invariant: a well-typed call should not throw. If this
    // fails, either the generated argument doesn't satisfy an implicit
    // precondition, or the PR introduced a new failure mode -- both are
    // worth a human look.
    expect(threw).toBe(false);${assertion ? `\n    ${assertion}` : ""}
  });`;
    })
    .join("\n\n");

  return `// AUTO-GENERATED by @acrv/test-generator -- edge-case tests for \`${fn.name}\`.
// These assert only "does not throw" and return-type invariants (no correctness
// oracle is available for AI-generated code). Combine with mutation testing to
// judge whether these tests meaningfully constrain the implementation.
import { describe, it, expect } from "vitest";
import { ${fn.name} } from "${importSpecifier}";

describe("${fn.name} (generated edge cases)", () => {
${testBodies}
});
`;
}

function buildPropertyTest(
  fn: ChangedFunction,
  specs: { param: ParamInfo; spec: ReturnType<typeof inferArbitrary> }[],
  importSpecifier: string,
): string {
  const defaults = specs.map((s) => defaultValueLiteral(s.param));
  const arbNames = specs.map((_, i) => `p${i}`);
  const arbList = specs
    .map((s, i) => (s.spec.supported ? s.spec.arbitraryExpr : `fc.constant(${defaults[i]})`))
    .join(", ");
  const paramList = arbNames.join(", ");
  const args = specs.map((_, i) => `p${i}`);
  const assertion = returnTypeAssertion(fn, "result");
  const propertyFn = fn.isAsync ? "asyncProperty" : "property";
  const asyncPrefix = fn.isAsync ? "async " : "";

  return `// AUTO-GENERATED by @acrv/test-generator -- property-based test for \`${fn.name}\`.
// Exercises hundreds of random inputs per parameter type and checks the same
// weak invariants as the edge-case tests. Its purpose is to give mutation
// testing broad input coverage, not to prove correctness.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ${fn.name} } from "${importSpecifier}";

describe("${fn.name} (generated property test)", () => {
  it("holds basic invariants across random inputs", ${asyncPrefix}() => {
    ${fn.isAsync ? "return " : ""}fc.assert(
      fc.${propertyFn}(${arbList ? `${arbList}, ` : ""}${asyncPrefix}(${paramList}) => {
        let threw = false;
        let result: unknown;
        try {
          result = ${callExpr(fn, args)};
        } catch (err) {
          threw = true;
        }
        expect(threw).toBe(false);${assertion ? `\n        ${assertion}` : ""}
      }),
      { numRuns: 200 },
    );
  });
});
`;
}
