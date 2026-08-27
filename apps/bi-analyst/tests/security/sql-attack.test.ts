import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSql } from "../../src/datasource/sql-validator.js";
import { test, section } from "../helpers/runner.js";

interface AttackCase {
  id: string;
  category: string;
  description: string;
  sql: string;
  expectValid: boolean;
  allowedTables?: string[];
  allowedColumns?: Record<string, string[]>;
  maxJoins?: number;
  maxCteDepth?: number;
  requireFilterTables?: string[];
}

interface AttackFixture {
  cases: AttackCase[];
}

function loadAttackFixture(): AttackFixture {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/security/sql-attacks.json",
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as AttackFixture;
}

export async function testSqlAttackSet() {
  section("SQL 安全攻击集 (SEC-*)");
  const fixture = loadAttackFixture();

  for (const attackCase of fixture.cases) {
    await test(`${attackCase.id} ${attackCase.description}`, () => {
      const result = validateSql(attackCase.sql, {
        allowedTables: attackCase.allowedTables,
        allowedColumns: attackCase.allowedColumns,
        maxJoins: attackCase.maxJoins,
        maxCteDepth: attackCase.maxCteDepth,
        requireFilterTables: attackCase.requireFilterTables,
      });
      assert.equal(
        result.valid,
        attackCase.expectValid,
        `${attackCase.id} (${attackCase.category}): expected valid=${attackCase.expectValid}, got valid=${result.valid}, reason=${result.reason ?? "none"}`,
      );
    });
  }
}
