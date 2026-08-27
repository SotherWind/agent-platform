import assert from "node:assert/strict";
import { createDatabase } from "../../src/db/seed.js";
import {
  scanSqliteSchema,
  scanMysqlSchemaFromRows,
  scanPostgresSchemaFromRows,
  introspectColdColumns,
  coldColumnsToDocuments,
} from "../../src/metadata/scanner.js";
import {
  gradeColumn,
  groupColumnsByGrade,
  shouldIndexColumn,
} from "../../src/metadata/grading.js";
import {
  diffSchemaDocuments,
  planIncrementalSync,
} from "../../src/metadata/sync.js";
import {
  planTableShards,
  planShardedIncrementalSync,
} from "../../src/metadata/shard-sync.js";
import { InMemoryMetadataReviewStore } from "../../src/metadata/review.js";
import {
  generateDraftDescription,
  assertNoAutoCertification,
} from "../../src/metadata/describe.js";
import { enrichDocumentForIndex } from "../../src/metadata/index-utils.js";
import { test, section } from "../helpers/runner.js";

export async function testPhaseFMetadata() {
  section("Phase F 元数据扫描与分级");

  await test("gradeColumn L1/L2/L3 规则", () => {
    assert.equal(
      gradeColumn({ fieldRole: "metric", columnName: "pay_amount" }),
      "L1",
    );
    assert.equal(
      gradeColumn({ fieldRole: "dimension", columnName: "city" }),
      "L2",
    );
    assert.equal(
      gradeColumn({ sensitivity: "pii", columnName: "phone" }),
      "L3",
    );
    assert.equal(shouldIndexColumn("L3"), false);
    assert.equal(shouldIndexColumn("L1"), true);

    const grouped = groupColumnsByGrade([
      { fieldRole: "metric", columnName: "amount" },
      { fieldRole: "dimension", columnName: "status" },
      { sensitivity: "sensitive", columnName: "ssn" },
    ]);
    assert.equal(grouped.L1.length, 1);
    assert.equal(grouped.L2.length, 1);
    assert.equal(grouped.L3.length, 1);
  });

  await test("scanSqliteSchema 生成 datasource/table/column 文档", () => {
    const db = createDatabase(":memory:");
    try {
      const docs = scanSqliteSchema(db, {
        datasourceId: "ecommerce_sqlite",
        domain: "retail",
        dialectFamily: "sqlite",
        tables: ["users", "orders"],
      });
      assert.ok(docs.some((d) => d.docType === "datasource"));
      assert.ok(docs.some((d) => d.docType === "table" && d.table === "users"));
      const userCols = docs.filter(
        (d) =>
          d.table === "users" &&
          (d.docType === "column" || d.docType === "column_group"),
      );
      assert.ok(userCols.length >= 3);
      assert.ok(userCols.some((d) => d.column === "city"));
    } finally {
      db.close();
    }
  });

  await test("增量同步 diff + plan", () => {
    const prev = [
      enrichDocumentForIndex(
        {
          id: "ds.t.a",
          docType: "column",
          content: "old a",
          datasourceId: "ds",
          domain: "retail",
          dialectFamily: "sqlite",
          table: "t",
          column: "a",
        },
        "1",
      ),
      enrichDocumentForIndex(
        {
          id: "ds.t.b",
          docType: "column",
          content: "same b",
          datasourceId: "ds",
          domain: "retail",
          dialectFamily: "sqlite",
          table: "t",
          column: "b",
        },
        "1",
      ),
    ];
    const next = [
      enrichDocumentForIndex(
        {
          id: "ds.t.a",
          docType: "column",
          content: "new a",
          datasourceId: "ds",
          domain: "retail",
          dialectFamily: "sqlite",
          table: "t",
          column: "a",
        },
        "1",
      ),
      enrichDocumentForIndex(
        {
          id: "ds.t.b",
          docType: "column",
          content: "same b",
          datasourceId: "ds",
          domain: "retail",
          dialectFamily: "sqlite",
          table: "t",
          column: "b",
        },
        "1",
      ),
      enrichDocumentForIndex(
        {
          id: "ds.t.c",
          docType: "column",
          content: "added c",
          datasourceId: "ds",
          domain: "retail",
          dialectFamily: "sqlite",
          table: "t",
          column: "c",
        },
        "1",
      ),
    ];
    // remove nothing from previous that isn't in next except we remove nothing;
    // remove b by omitting it... keep b. To test removed, drop nothing from next that was in prev except leave out nothing.
    // Actually remove by comparing: create next without ds.t.b conceptually — wait we kept b.
    // Add a third previous that is removed:
    const prev2 = [
      ...prev,
      enrichDocumentForIndex(
        {
          id: "ds.t.old",
          docType: "column",
          content: "gone",
          datasourceId: "ds",
          domain: "retail",
          dialectFamily: "sqlite",
          table: "t",
          column: "old",
        },
        "1",
      ),
    ];
    const diff = diffSchemaDocuments(prev2, next);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.unchanged.length, 1);
    const plan = planIncrementalSync(diff);
    assert.equal(plan.upsert.length, 2);
    assert.deepEqual(plan.tombstoneIds, ["ds.t.old"]);
    assert.equal(plan.skipped, 1);
  });

  await test("审核流 + LLM 草案禁止 auto-certification", () => {
    const store = new InMemoryMetadataReviewStore();
    const draft = generateDraftDescription({
      datasourceId: "ecommerce_sqlite",
      table: "users",
      column: "city",
      dataType: "TEXT",
      businessHint: "用户所在城市",
    });
    assert.equal(draft.reviewStatus, "draft");
    assertNoAutoCertification(draft);
    store.upsertDraft(draft);
    const approved = store.decide(draft.id, {
      status: "approved",
      reviewedBy: "admin",
    });
    assert.equal(approved.reviewStatus, "approved");

    assert.throws(
      () =>
        store.upsertDraft({
          ...draft,
          id: "x",
          tags: ["certified"],
        }),
      /certified/,
    );
  });

  await test("冷门列动态 introspection", () => {
    const db = createDatabase(":memory:");
    try {
      const indexed = scanSqliteSchema(db, {
        datasourceId: "ecommerce_sqlite",
        domain: "retail",
        dialectFamily: "sqlite",
        tables: ["users"],
      });
      const indexedSet = new Set(
        indexed.filter((d) => d.column).map((d) => `${d.table}.${d.column}`),
      );
      // 模拟仅索引部分列
      indexedSet.delete("users.name");
      const cold = introspectColdColumns(db, {
        datasourceId: "ecommerce_sqlite",
        tables: ["users"],
        indexedColumns: indexedSet,
      });
      assert.ok(cold.some((c) => c.name === "name"));
      const docs = coldColumnsToDocuments(cold, {
        datasourceId: "ecommerce_sqlite",
        domain: "retail",
        dialectFamily: "sqlite",
      });
      assert.ok(docs.every((d) => d.tags?.includes("cold-introspection")));
    } finally {
      db.close();
    }
  });

  await test("MySQL/PG INFORMATION_SCHEMA 行解析生成文档", () => {
    const mysqlRows = [
      {
        table_schema: "retail",
        table_name: "orders",
        column_name: "amount",
        data_type: "decimal",
        is_nullable: "NO",
      },
      {
        table_schema: "retail",
        table_name: "orders",
        column_name: "status",
        data_type: "varchar",
        is_nullable: "YES",
      },
      {
        table_schema: "other",
        table_name: "secret",
        column_name: "token",
        data_type: "text",
        is_nullable: "YES",
      },
    ];
    const mysqlDocs = scanMysqlSchemaFromRows(mysqlRows, {
      datasourceId: "sales_mysql",
      domain: "retail",
      dialectFamily: "mysql",
      schema: "retail",
    });
    assert.ok(mysqlDocs.some((d) => d.docType === "table" && d.table === "orders"));
    assert.ok(mysqlDocs.some((d) => d.column === "amount"));
    assert.ok(!mysqlDocs.some((d) => d.table === "secret"));
    assert.ok(mysqlDocs.every((d) => d.dialectFamily === "mysql"));

    const pgRows = [
      {
        table_schema: "public",
        table_name: "users",
        column_name: "city",
        data_type: "text",
        is_nullable: "YES",
      },
      {
        table_schema: "public",
        table_name: "users",
        column_name: "id",
        data_type: "integer",
        is_nullable: "NO",
      },
    ];
    const pgDocs = scanPostgresSchemaFromRows(pgRows, {
      datasourceId: "pg_retail",
      domain: "retail",
      dialectFamily: "postgresql",
      schema: "public",
    });
    assert.ok(pgDocs.some((d) => d.column === "city"));
    assert.ok(pgDocs.some((d) => d.column === "id"));
    assert.ok(pgDocs.every((d) => d.dialectFamily === "postgresql"));
  });

  await test("分片增量同步调度", () => {
    const shards = planTableShards(["c", "a", "b", "a"], 2);
    assert.equal(shards.length, 2);
    assert.deepEqual(shards[0]!.tables, ["a", "b"]);
    assert.deepEqual(shards[1]!.tables, ["c"]);
    assert.equal(shards[0]!.shardCount, 2);

    const mk = (id: string, table: string, content: string) =>
      enrichDocumentForIndex(
        {
          id,
          docType: "column",
          content,
          datasourceId: "ds",
          domain: "retail",
          dialectFamily: "sqlite",
          table,
          column: id.split(".").pop()!,
        },
        "1",
      );

    const previous = [mk("ds.a.x", "a", "old"), mk("ds.b.y", "b", "same")];
    const next = [mk("ds.a.x", "a", "new"), mk("ds.b.y", "b", "same")];
    const scheduled = planShardedIncrementalSync({
      previous,
      next,
      tables: ["a", "b"],
      shardSize: 1,
    });
    assert.equal(scheduled.shards.length, 2);
    assert.ok(scheduled.totals.upsert >= 1);
    assert.ok(
      scheduled.plans.some((p) =>
        p.plan.upsert.some((d) => d.id === "ds.a.x"),
      ),
    );
  });
}
