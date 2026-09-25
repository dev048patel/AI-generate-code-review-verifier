import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MutationResult, SurvivedMutant } from "@acrv/core";

interface MutantLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface MutantSchema {
  id: string;
  mutatorName: string;
  replacement?: string;
  location: MutantLocation;
  status: "Killed" | "Survived" | "NoCoverage" | "Timeout" | "RuntimeError" | "CompileError" | "Ignored" | "Pending";
}

interface MutationReportSchema {
  files: Record<string, { source?: string; mutants: MutantSchema[] }>;
}

/** Parses a `mutation-testing-report-schema` JSON file into our internal MutationResult shape. */
export async function parseMutationReport(
  reportPath: string,
  sandboxDir: string,
  durationMs: number,
  options: { includeNoCoverage?: boolean } = {},
): Promise<MutationResult> {
  const raw = await readFile(reportPath, "utf-8");
  const report = JSON.parse(raw) as MutationReportSchema;

  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;
  let total = 0;
  const survivedMutants: SurvivedMutant[] = [];

  for (const [filePath, fileEntry] of Object.entries(report.files)) {
    const sourceLines = fileEntry.source
      ? fileEntry.source.split("\n")
      : await readSourceLines(path.join(sandboxDir, filePath));

    for (const mutant of fileEntry.mutants) {
      total++;
      switch (mutant.status) {
        case "Killed":
          killed++;
          break;
        case "Timeout":
          timeout++;
          break;
        case "NoCoverage":
          noCoverage++;
          // Against a project's own suite, "no test even executes this line" is the headline finding.
          if (options.includeNoCoverage) {
            survivedMutants.push({
              id: mutant.id,
              file: filePath,
              line: mutant.location.start.line,
              mutatorName: mutant.mutatorName,
              originalCode: extractLines(sourceLines, mutant.location),
              mutatedCode: mutant.replacement ?? "<unknown>",
              status: "NoCoverage",
            });
          }
          break;
        case "Survived":
          survived++;
          survivedMutants.push({
            id: mutant.id,
            file: filePath,
            line: mutant.location.start.line,
            mutatorName: mutant.mutatorName,
            originalCode: extractLines(sourceLines, mutant.location),
            mutatedCode: mutant.replacement ?? "<unknown>",
            status: "Survived",
          });
          break;
        default:
          // Ignored / CompileError / RuntimeError / Pending: excluded from the score.
          total--;
      }
    }
  }

  const scoredDenominator = killed + survived + timeout + noCoverage;
  const mutationScore = scoredDenominator === 0 ? 100 : Math.round(((killed + timeout) / scoredDenominator) * 100);

  return {
    mutationScore,
    killed,
    survived,
    timeout,
    noCoverage,
    totalMutants: total,
    survivedMutants,
    durationMs,
  };
}

async function readSourceLines(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    return content.split("\n");
  } catch {
    return [];
  }
}

function extractLines(lines: string[], loc: MutantLocation): string {
  if (lines.length === 0) return "<source unavailable>";
  const slice = lines.slice(loc.start.line - 1, loc.end.line);
  return slice.join("\n").trim();
}
