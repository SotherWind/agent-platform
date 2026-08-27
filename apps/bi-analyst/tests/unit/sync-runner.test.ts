import assert from "node:assert/strict";
import { SchemaIndexer } from "../../src/metadata/indexer.js";
import { DeterministicEmbeddingProvider } from "../../src/metadata/embeddings.js";
import { InMemoryVectorIndexBackend } from "../../src/metadata/vector-backend.js";
import { runMetadataSync } from "../../src/metadata/sync-runner.js";
import type { SchemaDocument } from "../../src/metadata/types.js";
import { test, section } from "../helpers/runner.js";

function doc(
  id: string,
  content: string,
  extras?: Partial<SchemaDocument>,
): SchemaDocument {
  return {
    id,
    docType: "table",
    content,
    datasourceId: "ds1",
    domain: "retail",
    dialectFamily: "sqlite",
    table: id,
    reviewStatus: "approved",
    ...extras,
  };
}

export async function testMetadataSyncRunner() {
  section("MetadataSyncRunner (Phase F)");

  await test("首次同步走 rebuild + alias", async () => {
    const backend = new InMemoryVectorIndexBackend();
    const indexer = new SchemaIndexer({
      backend,
      embeddings: new DeterministicEmbeddingProvider(),
      collectionAlias: "bi-sync-test",
    });
    const next = [doc("users", "users table"), doc("orders", "orders table")];
    const result = await runMetadataSync({
      indexer,
      nextDocuments: next,
    });
    assert.equal(result.mode, "rebuild");
    assert.equal(result.upserted, 2);
    assert.ok(result.aliasSwap?.newCollection);
    assert.equal(await indexer.getAliasTarget(), result.aliasSwap!.newCollection);
  });

  await test("增量同步 upsert + tombstone", async () => {
    const backend = new InMemoryVectorIndexBackend();
    const indexer = new SchemaIndexer({
      backend,
      embeddings: new DeterministicEmbeddingProvider(),
      collectionAlias: "bi-sync-incr",
    });
    const v1 = [doc("users", "v1"), doc("orders", "v1")];
    const first = await runMetadataSync({
      indexer,
      nextDocuments: v1,
      mode: "rebuild",
    });
    assert.equal(first.mode, "rebuild");

    const v2 = [doc("users", "v2"), doc("products", "new")];
    const second = await runMetadataSync({
      indexer,
      previousDocuments: v1,
      nextDocuments: v2,
      mode: "incremental",
    });
    assert.equal(second.mode, "incremental");
    assert.equal(second.upserted, 2); // users changed + products added
    assert.equal(second.tombstoned, 1); // orders removed
    assert.deepEqual(second.plan.tombstoneIds, ["orders"]);
  });
}
