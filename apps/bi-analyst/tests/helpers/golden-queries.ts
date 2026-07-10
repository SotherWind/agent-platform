import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GoldenQueryExpectation } from "../../src/metadata/evaluation.js";

export function loadGoldenQueries(): GoldenQueryExpectation[] {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/golden-queries",
  );
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) =>
      JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as GoldenQueryExpectation,
    );
}
