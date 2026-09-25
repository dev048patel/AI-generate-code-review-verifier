import type { ChangedFunction, Finding } from "../types.js";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `fh-${idCounter}`;
}

const OFF_BY_ONE_LOOP_RE = /for\s*\([^;]*;\s*\w+\s*<=\s*[\w.]+\.length\s*;/;
const OUT_OF_BOUNDS_INDEX_RE = /(\w+)\[\1\.length\]/;
const DIVISOR_NAMES = ["divisor", "denominator", "count", "total", "n", "size", "b"];

/**
 * Whole-function-body pattern analysis that requires knowing parameter types
 * and the full source text of a function (not just adjacent diff lines).
 * This is intentionally used only by the LLM path (real Bedrock or the
 * MockProvider standing in for it) and NOT by the deterministic no-AI
 * baseline, so the evaluation harness can measure how much value semantic,
 * whole-function reasoning adds over a plain line-diff linter.
 */
export function runFunctionHeuristics(fn: ChangedFunction): Finding[] {
  const findings: Finding[] = [];
  const body = fn.sourceText;

  if (OFF_BY_ONE_LOOP_RE.test(body)) {
    findings.push({
      id: nextId(),
      source: "llm",
      severity: "high",
      file: fn.file,
      line: fn.startLine,
      title: `Off-by-one loop bound in \`${fn.name}\``,
      detail:
        "Loop condition compares the index with `<=` against `.length`, which will read one element past the end of the array/string on the final iteration.",
      evidence: firstMatchingLine(body, OFF_BY_ONE_LOOP_RE),
    });
  }

  const oobMatch = OUT_OF_BOUNDS_INDEX_RE.exec(body);
  if (oobMatch) {
    findings.push({
      id: nextId(),
      source: "llm",
      severity: "high",
      file: fn.file,
      line: fn.startLine,
      title: `Out-of-bounds index in \`${fn.name}\``,
      detail: `\`${oobMatch[1]}[${oobMatch[1]}.length]\` accesses one past the last valid index; the last valid index is \`${oobMatch[1]}.length - 1\`.`,
      evidence: oobMatch[0],
    });
  }

  // Missing null/undefined guard before accessing a property on a nullable/optional param.
  for (const param of fn.params) {
    const isNullable =
      param.optional ||
      (param.typeText ?? "").includes("null") ||
      (param.typeText ?? "").includes("undefined");
    if (!isNullable) continue;

    const accessRe = new RegExp(`\\b${escapeRegExp(param.name)}\\.[\\w]`, "g");
    const optionalAccessRe = new RegExp(`\\b${escapeRegExp(param.name)}\\?\\.`, "g");
    const guardRe = new RegExp(
      `if\\s*\\(\\s*!?\\s*${escapeRegExp(param.name)}\\b|${escapeRegExp(param.name)}\\s*(===|!==|==|!=)\\s*(null|undefined)`,
    );

    const hasUnguardedAccess = accessRe.test(body) && !optionalAccessRe.test(body.replace(accessRe, ""));
    if (hasUnguardedAccess && !guardRe.test(body)) {
      findings.push({
        id: nextId(),
        source: "llm",
        severity: "medium",
        file: fn.file,
        line: fn.startLine,
        title: `Possible null/undefined dereference of \`${param.name}\` in \`${fn.name}\``,
        detail: `Parameter \`${param.name}\` is typed as optional/nullable but is accessed with \`.\` without a preceding null check or optional chaining.`,
        evidence: firstMatchingLine(body, accessRe) ?? `${param.name}.<access>`,
      });
    }
  }

  // Division by a parameter/likely-count variable with no zero guard anywhere in the function.
  const divisionMatches = [...body.matchAll(/\/\s*([A-Za-z_$][\w]*)/g)];
  for (const m of divisionMatches) {
    const varName = m[1];
    if (!varName) continue;
    const looksLikeDivisor =
      DIVISOR_NAMES.includes(varName.toLowerCase()) ||
      fn.params.some((p) => p.name === varName);
    if (!looksLikeDivisor) continue;
    const zeroGuardRe = new RegExp(`${escapeRegExp(varName)}\\s*(===|!==|==|!=|>|<)\\s*0|0\\s*(===|!==|==|!=)\\s*${escapeRegExp(varName)}`);
    if (!zeroGuardRe.test(body)) {
      findings.push({
        id: nextId(),
        source: "llm",
        severity: "medium",
        file: fn.file,
        line: fn.startLine,
        title: `Possible division by zero in \`${fn.name}\``,
        detail: `\`${varName}\` is used as a divisor with no guard against it being zero anywhere in the function.`,
        evidence: m[0],
      });
      break; // one finding per function is enough signal
    }
  }

  return findings;
}

function firstMatchingLine(body: string, re: RegExp): string | undefined {
  return body.split("\n").find((l) => re.test(l))?.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
