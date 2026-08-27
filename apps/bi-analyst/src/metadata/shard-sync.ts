import {
  diffSchemaDocuments,
  planIncrementalSync,
  type IncrementalSyncPlan,
  type SchemaSyncDiff,
} from "./sync.js";
import type { SchemaDocument } from "./types.js";

export interface TableShard {
  shardIndex: number;
  shardCount: number;
  tables: string[];
}

export interface ShardSyncPlan {
  shards: TableShard[];
  /** 按分片切开的文档集上跑 diff+plan 的结果 */
  plans: Array<{
    shardIndex: number;
    tables: string[];
    plan: IncrementalSyncPlan;
    diff: SchemaSyncDiff;
  }>;
  totals: {
    upsert: number;
    tombstone: number;
    skipped: number;
  };
}

/**
 * 将表名列表切成固定大小分片，供增量元数据同步调度。
 * 稳定排序后切片，保证同输入同输出。
 */
export function planTableShards(
  tables: string[],
  shardSize: number,
): TableShard[] {
  const size = Math.max(1, Math.floor(shardSize));
  const sorted = [...new Set(tables)].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) return [];

  const shards: TableShard[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    shards.push({
      shardIndex: shards.length,
      shardCount: 0, // 稍后回填
      tables: sorted.slice(i, i + size),
    });
  }
  for (const shard of shards) {
    shard.shardCount = shards.length;
  }
  return shards;
}

function docsForTables(
  docs: SchemaDocument[],
  tables: string[],
): SchemaDocument[] {
  const set = new Set(tables);
  return docs.filter((d) => {
    if (d.docType === "datasource") return true;
    if (d.table && set.has(d.table)) return true;
    return false;
  });
}

/**
 * 分片增量同步：对每个表分片独立计算 upsert/tombstone，适合大批量表调度。
 */
export function planShardedIncrementalSync(input: {
  previous: SchemaDocument[];
  next: SchemaDocument[];
  tables: string[];
  shardSize: number;
}): ShardSyncPlan {
  const shards = planTableShards(input.tables, input.shardSize);
  const plans: ShardSyncPlan["plans"] = [];
  let upsert = 0;
  let tombstone = 0;
  let skipped = 0;

  for (const shard of shards) {
    const prev = docsForTables(input.previous, shard.tables);
    const next = docsForTables(input.next, shard.tables);
    // datasource 文档只在首片参与 tombstone/upsert，避免重复
    const prevScoped =
      shard.shardIndex === 0
        ? prev
        : prev.filter((d) => d.docType !== "datasource");
    const nextScoped =
      shard.shardIndex === 0
        ? next
        : next.filter((d) => d.docType !== "datasource");

    const diff = diffSchemaDocuments(prevScoped, nextScoped);
    const plan = planIncrementalSync(diff);
    plans.push({
      shardIndex: shard.shardIndex,
      tables: shard.tables,
      plan,
      diff,
    });
    upsert += plan.upsert.length;
    tombstone += plan.tombstoneIds.length;
    skipped += plan.skipped;
  }

  return {
    shards,
    plans,
    totals: { upsert, tombstone, skipped },
  };
}
