import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SeededBug } from "@acrv/core";

export interface FixtureMeta {
  prTitle: string;
  prDescription: string;
  files: string[];
  isCleanControl: boolean;
  seededBugs: SeededBug[];
}

export interface Fixture {
  id: string;
  meta: FixtureMeta;
  dir: string;
}

export const FIXTURES_DIR = path.resolve(fileURLToPath(new URL("../fixtures/", import.meta.url)));

/** Loads every benchmark fixture under `dir` (default: the seeded fixtures in packages/eval-harness/fixtures/). */
export async function loadFixtures(dir: string = FIXTURES_DIR): Promise<Fixture[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const fixtures: Fixture[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fixtureDir = path.join(dir, entry.name);
    const metaRaw = await readFile(path.join(fixtureDir, "meta.json"), "utf-8").catch(() => null);
    if (metaRaw === null) continue;
    fixtures.push({ id: entry.name, meta: JSON.parse(metaRaw) as FixtureMeta, dir: fixtureDir });
  }

  return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}

export interface FixtureFileContents {
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

/** Reads the before/after content for every file a fixture declares. `null` means the file doesn't exist on that side (new or deleted file). */
export async function readFixtureFileContents(fixture: Fixture): Promise<FixtureFileContents> {
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};

  for (const relPath of fixture.meta.files) {
    before[relPath] = await tryRead(path.join(fixture.dir, "before", relPath));
    after[relPath] = await tryRead(path.join(fixture.dir, "after", relPath));
  }

  return { before, after };
}

async function tryRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
