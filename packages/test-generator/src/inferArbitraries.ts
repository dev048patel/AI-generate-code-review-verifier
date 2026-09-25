export interface ArbitrarySpec {
  supported: boolean;
  /** fast-check arbitrary expression, e.g. "fc.integer({ min: -1000, max: 1000 })". */
  arbitraryExpr: string;
  /** Source-literal edge-case values to test individually, e.g. ["0", "-1", '""']. */
  edgeCaseLiterals: string[];
}

const UNSUPPORTED: ArbitrarySpec = { supported: false, arbitraryExpr: "", edgeCaseLiterals: [] };

/**
 * Maps a TypeScript type string (as text, from the checker) to a fast-check
 * arbitrary and a curated set of edge-case literals. Only a pragmatic subset
 * of types is supported (primitives and arrays of primitives); anything else
 * is reported unsupported so the caller can skip generation gracefully
 * rather than emit incorrect test code.
 */
export function inferArbitrary(typeText: string | null | undefined): ArbitrarySpec {
  if (!typeText) return UNSUPPORTED;
  const t = normalize(typeText);

  if (t === "number") {
    return {
      supported: true,
      arbitraryExpr: "fc.integer({ min: -1_000_000, max: 1_000_000 })",
      edgeCaseLiterals: ["0", "-1", "1", "-0.5", "Number.MAX_SAFE_INTEGER", "-Number.MAX_SAFE_INTEGER"],
    };
  }

  if (t === "string") {
    return {
      supported: true,
      arbitraryExpr: "fc.string({ maxLength: 50 })",
      edgeCaseLiterals: ['""', '" "', '"a"', '"a".repeat(500)', '"\\u{1F680}"'],
    };
  }

  if (t === "boolean") {
    return {
      supported: true,
      arbitraryExpr: "fc.boolean()",
      edgeCaseLiterals: ["true", "false"],
    };
  }

  const arrayMatch = /^(\w+)\[\]$/.exec(t) ?? /^array<\s*(\w+)\s*>$/.exec(t);
  if (arrayMatch) {
    const inner = inferArbitrary(arrayMatch[1]);
    if (!inner.supported) return UNSUPPORTED;
    return {
      supported: true,
      arbitraryExpr: `fc.array(${inner.arbitraryExpr}, { maxLength: 20 })`,
      edgeCaseLiterals: ["[]", `[${inner.edgeCaseLiterals[0] ?? "0"}]`],
    };
  }

  return UNSUPPORTED;
}

function normalize(typeText: string): string {
  return typeText.trim().toLowerCase().replace(/^readonly\s+/, "");
}
