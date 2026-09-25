import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { WorkspaceExecution } from "@acrv/pipeline";

/**
 * The execute job's output. It's written on a machine that just ran the PR's
 * code, so the reporting job treats it as hostile input: strict schema, size
 * caps, and (in the pipeline) a head-SHA check. It can at worst misreport its
 * own PR's test results -- it can't inject markup, reach secrets, or point
 * the report at a different PR.
 */
const str = (max: number) => z.string().max(max);
const count = z.number().int().min(0).max(1_000_000);

const MutationSchema = z.object({
  mutationScore: z.number().min(0).max(100),
  killed: count,
  survived: count,
  timeout: count,
  noCoverage: count,
  totalMutants: count,
  durationMs: z.number().min(0),
  survivedMutants: z
    .array(
      z.object({
        id: str(100),
        file: str(500),
        line: z.number().int().min(0),
        mutatorName: str(100),
        originalCode: str(2000),
        mutatedCode: str(2000),
        status: z.enum(["Survived", "NoCoverage"]).optional(),
      }),
    )
    .max(500),
});

const ExecutionSchema = z.object({
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  execution: z.object({
    executor: z.enum(["local", "docker", "none"]),
    isolated: z.boolean(),
    skippedReason: str(500).optional(),
    notes: z.array(str(1000)).max(50).optional(),
  }),
  generatedTests: z
    .array(
      z.object({
        targetFunctionId: str(500),
        file: str(500),
        content: str(50_000),
        kind: z.enum(["edge-case", "property"]),
      }),
    )
    .max(200),
  testRun: z
    .object({
      passed: count,
      failed: count,
      total: count,
      durationMs: z.number().min(0),
      failures: z.array(z.object({ testName: str(500), message: str(4000) })).max(200),
    })
    .optional(),
  ownTestsMutation: MutationSchema.optional(),
});

export const ExecutionFileSchema = z.object({
  version: z.literal(1),
  prNumber: z.number().int().positive(),
  execution: ExecutionSchema,
});

export type ExecutionFile = z.infer<typeof ExecutionFileSchema>;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function writeExecutionFile(file: string, prNumber: number, execution: WorkspaceExecution): Promise<void> {
  const payload: ExecutionFile = ExecutionFileSchema.parse({ version: 1, prNumber, execution });
  await writeFile(file, JSON.stringify(payload), "utf-8");
}

export async function readExecutionFile(file: string): Promise<ExecutionFile> {
  const raw = await readFile(file, "utf-8");
  if (raw.length > MAX_FILE_BYTES) throw new Error(`Execution file ${file} is larger than ${MAX_FILE_BYTES} bytes`);
  return ExecutionFileSchema.parse(JSON.parse(raw));
}
