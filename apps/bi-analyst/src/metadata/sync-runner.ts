import type { SchemaDocument } from "./types.js";
import type { SchemaIndexer, AliasSwapResult } from "./indexer.js";
import {
  diffSchemaDocuments,
  planIncrementalSync,
  type SchemaSyncDiff,
  type IncrementalSyncPlan,
} from "./sync.js";
import {
  planShardedIncrementalSync,
  type ShardSyncPlan,
} from "./shard-sync.js";

export type MetadataSyncMode = "incremental" | "rebuild";

export interface MetadataSyncRunInput {
  indexer: SchemaIndexer;
  /** 扫描得到的最新文档集 */
  nextDocuments: SchemaDocument[];
  /** 上一版文档快照；缺省视为空（首次 rebuild） */
  previousDocuments?: SchemaDocument[];
  /**
   * incremental：对当前 alias 目标 collection upsert + tombstone
   * rebuild：全量写入新 collection 并原子切换 alias
   */
  mode?: MetadataSyncMode;
  /** 启用分片计划（仅返回计划统计；执行仍按整体 upsert） */
  shardByTable?: boolean;
  shardSize?: number;
}

export interface MetadataSyncRunResult {
  mode: MetadataSyncMode;
  diff: SchemaSyncDiff;
  plan: IncrementalSyncPlan;
  sharded?: ShardSyncPlan;
  upserted: number;
  tombstoned: number;
  aliasSwap?: AliasSwapResult;
  collection: string | null;
}

/**
 * 元数据连库同步编排：diff → plan → apply（upsert/tombstone 或 alias rebuild）。
 * 调度侧（cron / API）调用本函数即可完成一次同步周期。
 */
export async function runMetadataSync(
  input: MetadataSyncRunInput,
): Promise<MetadataSyncRunResult> {
  const previous =
    input.previousDocuments ?? (await input.indexer.readCurrentDocuments());
  const next = input.nextDocuments;
  const diff = diffSchemaDocuments(previous, next);
  const plan = planIncrementalSync(diff);
  const tables = [
    ...new Set(
      [...previous, ...next]
        .map((d) => d.table)
        .filter((t): t is string => Boolean(t)),
    ),
  ];
  const sharded = input.shardByTable
    ? planShardedIncrementalSync({
        previous,
        next,
        tables,
        shardSize: input.shardSize ?? 50,
      })
    : undefined;

  const preferRebuild =
    input.mode === "rebuild" ||
    previous.length === 0 ||
    !(await input.indexer.getAliasTarget());

  if (preferRebuild) {
    const aliasSwap = await input.indexer.rebuildWithAliasSwap(next);
    return {
      mode: "rebuild",
      diff,
      plan,
      sharded,
      upserted: next.length,
      tombstoned: 0,
      aliasSwap,
      collection: aliasSwap.newCollection,
    };
  }

  const collection = await input.indexer.getAliasTarget();
  if (!collection) {
    const aliasSwap = await input.indexer.rebuildWithAliasSwap(next);
    return {
      mode: "rebuild",
      diff,
      plan,
      sharded,
      upserted: next.length,
      tombstoned: 0,
      aliasSwap,
      collection: aliasSwap.newCollection,
    };
  }

  if (plan.upsert.length > 0) {
    await input.indexer.indexDocuments(plan.upsert, collection);
  }
  if (plan.tombstoneIds.length > 0) {
    await input.indexer.tombstone(plan.tombstoneIds, collection);
  }

  return {
    mode: "incremental",
    diff,
    plan,
    sharded,
    upserted: plan.upsert.length,
    tombstoned: plan.tombstoneIds.length,
    collection,
  };
}
