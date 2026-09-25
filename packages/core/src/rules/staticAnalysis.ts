import type { DiffFile, Finding } from "../types.js";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

interface HunkLine {
  marker: "+" | "-" | " ";
  text: string;
  /** "after" file line number; only meaningful for "+" and " " lines. */
  newLine: number;
}

function flattenWithLineNumbers(file: DiffFile): HunkLine[] {
  const out: HunkLine[] = [];
  for (const hunk of file.hunks) {
    let cursor = hunk.newStart;
    for (const raw of hunk.lines) {
      if (raw.startsWith("+++") || raw.startsWith("---")) continue;
      if (raw.startsWith("+")) {
        out.push({ marker: "+", text: raw.slice(1), newLine: cursor });
        cursor++;
      } else if (raw.startsWith("-")) {
        out.push({ marker: "-", text: raw.slice(1), newLine: cursor });
      } else {
        out.push({ marker: " ", text: raw.slice(1), newLine: cursor });
        cursor++;
      }
    }
  }
  return out;
}

const NULL_GUARD_RE = /if\s*\(\s*!?\s*[\w.]+\s*(===?|!==?)?\s*(null|undefined)?\s*\)/;
const COMPARISON_RE = /(<=|>=|===|!==|==|!=|<|>)/;
const CATCH_EMPTY_RE = /catch\s*\([^)]*\)\s*{\s*(\/\/.*)?\s*}/;
const SQL_KEYWORD_RE = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
const TEMPLATE_SQL_RE = /`[^`]*(SELECT|INSERT|UPDATE|DELETE)[^`]*\$\{[^}]+\}[^`]*`/i;

/** A SQL keyword plus a `+` concatenation, both inside the same (quoted) line -- deliberately quote-style-agnostic since real SQL literals mix ' and " freely. */
function looksLikeConcatenatedSql(text: string): boolean {
  return SQL_KEYWORD_RE.test(text) && text.includes("+") && /["'`]/.test(text);
}
const LOOSE_EQUALITY_RE = /[^=!]==[^=]|[^!]!=[^=]/;

/**
 * Deterministic, non-LLM static detectors. Used both as (a) rule-based
 * "findings" surfaced in every review regardless of LLM availability, and
 * (b) the "no-AI baseline" in the evaluation harness, so the benchmark can
 * report how much the LLM stage adds over plain pattern matching.
 */
export function runStaticAnalysis(file: DiffFile): Finding[] {
  if (file.isBinary) return [];
  const findings: Finding[] = [];
  const lines = flattenWithLineNumbers(file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // 1. Removed null/undefined guard that has no added replacement nearby.
    if (line.marker === "-" && NULL_GUARD_RE.test(line.text)) {
      const windowAdds = lines
        .slice(Math.max(0, i - 3), i + 4)
        .filter((l) => l.marker === "+");
      const replaced = windowAdds.some((l) => NULL_GUARD_RE.test(l.text));
      if (!replaced) {
        findings.push({
          id: nextId("rule"),
          source: "rule",
          severity: "high",
          file: file.newPath,
          line: line.newLine,
          title: "Null/undefined guard removed",
          detail:
            "A conditional guard against null/undefined was deleted without an equivalent replacement nearby. This can reintroduce a null-dereference crash.",
          evidence: line.text.trim(),
        });
      }
    }

    // 2. Comparison operator changed between a deleted and its matching added line.
    if (line.marker === "-") {
      const next = lines[i + 1];
      if (next && next.marker === "+") {
        const oldOp = COMPARISON_RE.exec(line.text)?.[1];
        const newOp = COMPARISON_RE.exec(next.text)?.[1];
        if (oldOp && newOp && oldOp !== newOp) {
          const oldStripped = line.text.replace(COMPARISON_RE, "OP");
          const newStripped = next.text.replace(COMPARISON_RE, "OP");
          if (oldStripped.trim() === newStripped.trim()) {
            findings.push({
              id: nextId("rule"),
              source: "rule",
              severity: "medium",
              file: file.newPath,
              line: next.newLine,
              title: `Comparison operator changed (${oldOp} -> ${newOp})`,
              detail:
                "A comparison operator changed while the rest of the expression stayed identical. Verify this isn't an off-by-one or boundary-condition regression.",
              evidence: `- ${line.text.trim()}\n+ ${next.text.trim()}`,
            });
          }
        }
      }
    }

    // 3. Boolean logic swap (&& <-> ||) between matching deleted/added lines.
    if (line.marker === "-" && (line.text.includes("&&") || line.text.includes("||"))) {
      const next = lines[i + 1];
      if (next && next.marker === "+") {
        const oldNorm = line.text.replace(/&&|\|\|/g, "BOOL");
        const newNorm = next.text.replace(/&&|\|\|/g, "BOOL");
        const oldHasAnd = line.text.includes("&&");
        const newHasOr = next.text.includes("||");
        if (oldNorm.trim() === newNorm.trim() && oldHasAnd && newHasOr) {
          findings.push({
            id: nextId("rule"),
            source: "rule",
            severity: "high",
            file: file.newPath,
            line: next.newLine,
            title: "Boolean operator swapped (&& -> ||)",
            detail:
              "A logical AND was changed to a logical OR (or vice versa) without other changes, which typically flips the intended condition.",
            evidence: `- ${line.text.trim()}\n+ ${next.text.trim()}`,
          });
        }
      }
    }

    // 4. Added `await` removed / async call without await.
    if (line.marker === "-" && /\bawait\b/.test(line.text)) {
      const next = lines[i + 1];
      if (next && next.marker === "+" && !/\bawait\b/.test(next.text)) {
        const oldStripped = line.text.replace(/\bawait\s+/, "");
        if (oldStripped.trim() === next.text.trim()) {
          findings.push({
            id: nextId("rule"),
            source: "rule",
            severity: "high",
            file: file.newPath,
            line: next.newLine,
            title: "`await` removed from asynchronous call",
            detail:
              "A previously-awaited call is no longer awaited. This can cause unhandled promise rejections or races.",
            evidence: `- ${line.text.trim()}\n+ ${next.text.trim()}`,
          });
        }
      }
    }

    // 5. Empty catch block (swallowed exception).
    if (line.marker === "+" && CATCH_EMPTY_RE.test(line.text)) {
      findings.push({
        id: nextId("rule"),
        source: "rule",
        severity: "medium",
        file: file.newPath,
        line: line.newLine,
        title: "Empty catch block swallows exceptions",
        detail: "An exception is caught and silently discarded, hiding failures.",
        evidence: line.text.trim(),
      });
    }

    // 6b. Negation added/removed around an otherwise-identical expression
    //     (e.g. `return !isValid;` -> `return isValid;`), a classic
    //     mutation-testing-style bug that silently flips control flow.
    if (line.marker === "-") {
      const next = lines[i + 1];
      if (next && next.marker === "+") {
        const oldHasBang = /[^!=]!(?!=)/.test(line.text);
        const newHasBang = /[^!=]!(?!=)/.test(next.text);
        if (oldHasBang !== newHasBang) {
          const strip = (s: string) => s.replace(/([^!=])!(?!=)/g, "$1").trim();
          if (strip(line.text) === strip(next.text)) {
            findings.push({
              id: nextId("rule"),
              source: "rule",
              severity: "high",
              file: file.newPath,
              line: next.newLine,
              title: "Boolean negation added or removed",
              detail:
                "A `!` negation was added or removed around an otherwise identical expression, which silently flips the resulting logic or return value.",
              evidence: `- ${line.text.trim()}\n+ ${next.text.trim()}`,
            });
          }
        }
      }
    }

    // 6. SQL built via string concatenation / template interpolation.
    if (line.marker === "+" && (looksLikeConcatenatedSql(line.text) || TEMPLATE_SQL_RE.test(line.text))) {
      findings.push({
        id: nextId("rule"),
        source: "rule",
        severity: "critical",
        file: file.newPath,
        line: line.newLine,
        title: "Possible SQL injection via string interpolation",
        detail:
          "A SQL statement appears to be built by concatenating or interpolating a variable directly into the query string. Use parameterized queries instead.",
        evidence: line.text.trim(),
      });
    }

    // 7. Loose equality introduced where strict equality existed before, or newly added.
    if (line.marker === "+" && LOOSE_EQUALITY_RE.test(line.text) && !line.text.includes("===") && !line.text.includes("!==")) {
      findings.push({
        id: nextId("rule"),
        source: "rule",
        severity: "low",
        file: file.newPath,
        line: line.newLine,
        title: "Loose equality (==/!=) used",
        detail: "Loose equality can cause unexpected type coercion; prefer === / !==.",
        evidence: line.text.trim(),
      });
    }
  }

  return findings;
}
