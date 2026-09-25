import { Project, SyntaxKind, type Node } from "ts-morph";
import type { ChangedFunction, FunctionKind, ParamInfo } from "../types.js";

const FUNCTION_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Constructor,
] as const;

function kindFor(node: Node): FunctionKind {
  switch (node.getKind()) {
    case SyntaxKind.MethodDeclaration:
      return "method";
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionExpression:
      return "arrow";
    case SyntaxKind.Constructor:
      return "constructor";
    default:
      return "function";
  }
}

function nameFor(node: Node): string {
  const anyNode = node as { getName?: () => string | undefined };
  const direct = anyNode.getName?.();
  if (direct) return direct;

  // Arrow/function expressions assigned to a const/let/var: use the variable name.
  const varDecl = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (varDecl) return varDecl.getName();

  // Object literal property: `foo: (x) => ...`
  const propAssign = node.getParentIfKind(SyntaxKind.PropertyAssignment);
  if (propAssign) return propAssign.getName();

  return "<anonymous>";
}

function paramsFor(node: Node): ParamInfo[] {
  const anyNode = node as {
    getParameters?: () => Array<{
      getName: () => string;
      getType: () => { getText: () => string };
      isOptional: () => boolean;
      hasInitializer: () => boolean;
    }>;
  };
  const params = anyNode.getParameters?.() ?? [];
  return params.map((p) => ({
    name: p.getName(),
    typeText: safeTypeText(p),
    optional: p.isOptional(),
    hasDefault: p.hasInitializer(),
  }));
}

function safeTypeText(p: { getType: () => { getText: () => string } }): string | null {
  try {
    const text = p.getType().getText();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Parses the "after" content of a source file (TS/TSX/JS/JSX) and returns every
 * top-level or nested function/method/arrow-function whose body overlaps the
 * given set of changed line numbers, plus every exported function in the file
 * (so generated tests can also target untouched-but-related functions if desired).
 */
export function extractChangedFunctions(
  filePath: string,
  afterSource: string,
  changedLines: number[],
): ChangedFunction[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile(filePath, afterSource, { overwrite: true });

  const changedSet = new Set(changedLines);
  const results: ChangedFunction[] = [];
  const seen = new Set<string>();

  for (const kind of FUNCTION_KINDS) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      const startLine = node.getStartLineNumber();
      const endLine = node.getEndLineNumber();
      const key = `${startLine}:${endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let directlyChanged = false;
      for (const ln of changedSet) {
        if (ln >= startLine && ln <= endLine) {
          directlyChanged = true;
          break;
        }
      }

      const isAsync =
        "isAsync" in node && typeof (node as { isAsync: () => boolean }).isAsync === "function"
          ? (node as { isAsync: () => boolean }).isAsync()
          : /\basync\b/.test(node.getText().slice(0, 20));

      results.push({
        id: `${filePath}:${startLine}-${endLine}`,
        file: filePath,
        name: nameFor(node),
        kind: kindFor(node),
        startLine,
        endLine,
        sourceText: node.getText(),
        params: paramsFor(node),
        returnTypeText: getReturnTypeText(node),
        isAsync,
        isExported: isExportedNode(node),
        directlyChanged,
      });
    }
  }

  return results.filter((f) => f.directlyChanged);
}

/**
 * Determines whether a function-like node is reachable from outside its
 * module: a `function`/`class` declaration marked `export`, or an arrow /
 * function expression assigned to an `export const`/`export let` binding.
 */
function isExportedNode(node: Node): boolean {
  if (node.getKind() === SyntaxKind.FunctionDeclaration) {
    const fn = node as Node & { isExported: () => boolean; isDefaultExport: () => boolean };
    return fn.isExported() || fn.isDefaultExport();
  }

  if (node.getKind() === SyntaxKind.MethodDeclaration || node.getKind() === SyntaxKind.Constructor) {
    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    if (!classDecl) return false;
    return classDecl.isExported() || classDecl.isDefaultExport();
  }

  // Arrow function / function expression: exported iff assigned to an
  // exported variable statement, e.g. `export const multiply = (a, b) => ...`.
  const varStatement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  if (varStatement) {
    return varStatement.isExported() || varStatement.isDefaultExport();
  }

  return false;
}

function getReturnTypeText(node: Node): string | null {
  // Prefer the explicit return-type annotation's own text over the checker's
  // inferred type: the in-memory ts-morph project has no lib files loaded,
  // so checker-inferred types for things like array indexing or union
  // annotations can come back wrong (e.g. `number | undefined` resolving to
  // just `number`). The annotation, when present, is exactly what the code
  // says and needs no type-checking to read.
  const anyNode = node as { getReturnTypeNode?: () => Node | undefined };
  const annotation = anyNode.getReturnTypeNode?.();
  if (annotation) return annotation.getText();

  const typedNode = node as { getReturnType?: () => { getText: () => string } };
  try {
    const t = typedNode.getReturnType?.();
    return t ? t.getText() : null;
  } catch {
    return null;
  }
}
