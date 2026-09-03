import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvaluationFixtureSchema, SPECIALIST_CATEGORIES, type EvaluationFixture, type SpecialistCategory } from "./types";

const DEFAULT_FIXTURE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

export async function loadFixtureFile(
  filePath: string,
  expectedCategory?: SpecialistCategory,
): Promise<EvaluationFixture[]> {
  const content = await readFile(filePath, "utf8");
  const fixtures: EvaluationFixture[] = [];

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL in ${filePath}:${index + 1}: ${String(error)}`);
    }
    const fixture = EvaluationFixtureSchema.parse(parsed);
    if (expectedCategory && fixture.category !== expectedCategory) {
      throw new Error(
        `Fixture ${fixture.id} in ${filePath} belongs to ${fixture.category}, expected ${expectedCategory}`,
      );
    }
    fixtures.push(fixture);
  }

  return fixtures;
}

export async function loadEvaluationFixtures(
  fixtureDir = DEFAULT_FIXTURE_DIR,
): Promise<EvaluationFixture[]> {
  const resolvedDir = resolve(fixtureDir);
  const files = await readdir(resolvedDir);
  const loaded: EvaluationFixture[] = [];

  for (const category of SPECIALIST_CATEGORIES) {
    const fileName = `${category}.jsonl`;
    if (!files.includes(fileName)) {
      throw new Error(`Missing specialist fixture file: ${join(resolvedDir, fileName)}`);
    }
    loaded.push(...(await loadFixtureFile(join(resolvedDir, fileName), category)));
  }

  const unexpectedFiles = files.filter((file) => extname(file) === ".jsonl" && !SPECIALIST_CATEGORIES.some((category) => file === `${category}.jsonl`));
  if (unexpectedFiles.length > 0) {
    throw new Error(`Unexpected fixture files: ${unexpectedFiles.join(", ")}`);
  }

  return loaded;
}

export function fixtureCategoryFromPath(filePath: string): SpecialistCategory {
  const category = basename(filePath, extname(filePath));
  if (!SPECIALIST_CATEGORIES.includes(category as SpecialistCategory)) {
    throw new Error(`Unknown specialist fixture category in ${filePath}`);
  }
  return category as SpecialistCategory;
}

export function defaultFixtureDirectory(): string {
  return resolve(DEFAULT_FIXTURE_DIR);
}
