import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectProductionArtifact } from "../../scripts/verify-production-artifact.js";
import { section, test } from "../helpers/runner.js";

export async function testArtifactBoundary(): Promise<void> {
  section("Production artifact boundary");

  await test("accepts a minimal closed production graph", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bi-artifact-clean-"));
    try {
      fs.writeFileSync(path.join(dir, "main.js"), 'import "./runtime.js";\n');
      fs.writeFileSync(path.join(dir, "runtime.js"), "export const ok = true;\n");
      assert.deepEqual(inspectProductionArtifact(dir).violations, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("rejects test identities, demo modules, and dangling imports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bi-artifact-bad-"));
    try {
      fs.mkdirSync(path.join(dir, "db"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "main.js"),
        'import "./missing.js"; const subjectId = "user-test";\n',
      );
      fs.writeFileSync(path.join(dir, "db", "seed.js"), "export {};\n");
      const violations = inspectProductionArtifact(dir).violations.join("\n");
      assert.match(violations, /forbidden content/);
      assert.match(violations, /db\/seed\.js/);
      assert.match(violations, /dangling import/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
