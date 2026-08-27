import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { TASKS } from "@langchain/langgraph-checkpoint";
import pg from "pg";
import { resolvePostgresAuditConnectionFromEnv } from "../audit/postgres-store.js";

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    checkpoint_data TEXT NOT NULL,
    metadata_data TEXT NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  );
  CREATE TABLE IF NOT EXISTS langgraph_writes (
    outer_key TEXT NOT NULL,
    inner_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    value_data TEXT NOT NULL,
    PRIMARY KEY (outer_key, inner_key)
  );
  CREATE INDEX IF NOT EXISTS idx_pg_langgraph_writes_outer
    ON langgraph_writes(outer_key);
`;

function assertSafeStorageKey(
  field: string,
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): void {
  const { allowEmpty = false } = options;
  if (typeof value !== "string") {
    throw new Error(`Invalid configurable value for key "${field}"`);
  }
  if (!allowEmpty && value === "") {
    throw new Error(`Invalid configurable value for key "${field}": empty string`);
  }
  if (POLLUTION_KEYS.has(value)) {
    throw new Error(`Invalid configurable value for key "${field}": reserved key`);
  }
}

function generateWriteKey(
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string,
): string {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

export interface PostgresCheckpointSaverOptions {
  connectionString?: string;
}

/**
 * PostgreSQL 持久化 LangGraph checkpointer（quasi-production / staging）。
 * 与 SqliteCheckpointSaver 语义对齐；需 CHECKPOINT_DATABASE_URL 或复用 AUDIT_DATABASE_URL。
 */
export class PostgresCheckpointSaver extends BaseCheckpointSaver {
  private readonly pool: pg.Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(options: PostgresCheckpointSaverOptions = {}) {
    super();
    const connectionString =
      options.connectionString ?? resolveCheckpointConnectionFromEnv();
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
    });
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.pool.query(INIT_SQL).then(() => undefined);
    }
    await this.schemaReady;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.ensureSchema();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    let checkpointId: string | undefined = getCheckpointId(config);

    if (threadId !== undefined) assertSafeStorageKey("thread_id", threadId);
    assertSafeStorageKey("checkpoint_ns", checkpointNs, { allowEmpty: true });
    if (checkpointId) assertSafeStorageKey("checkpoint_id", checkpointId);

    if (!threadId) return undefined;

    if (!checkpointId) {
      const latest = await this.pool.query(
        `SELECT checkpoint_id FROM langgraph_checkpoints
         WHERE thread_id = $1 AND checkpoint_ns = $2
         ORDER BY checkpoint_id DESC LIMIT 1`,
        [threadId, checkpointNs],
      );
      checkpointId = latest.rows[0]?.checkpoint_id as string | undefined;
      if (!checkpointId) return undefined;
    }

    const result = await this.pool.query(
      `SELECT * FROM langgraph_checkpoints
       WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`,
      [threadId, checkpointNs, checkpointId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const deserializedCheckpoint = await this.serde.loadsTyped(
      "json",
      row.checkpoint_data as string,
    );
    const metadata = await this.serde.loadsTyped(
      "json",
      row.metadata_data as string,
    );

    const outerKey = generateWriteKey(threadId, checkpointNs, checkpointId);
    const writeResult = await this.pool.query(
      `SELECT task_id, channel, value_data FROM langgraph_writes
       WHERE outer_key = $1 ORDER BY inner_key`,
      [outerKey],
    );

    const pendingWrites = await Promise.all(
      writeResult.rows.map(async (w) => [
        String(w.task_id),
        String(w.channel),
        await this.serde.loadsTyped("json", String(w.value_data)),
      ]),
    );

    const parentCheckpointId = row.parent_checkpoint_id
      ? String(row.parent_checkpoint_id)
      : undefined;

    if (deserializedCheckpoint.v < 4 && parentCheckpointId) {
      await this.migratePendingSends(
        deserializedCheckpoint,
        threadId,
        checkpointNs,
        parentCheckpointId,
      );
    }

    const checkpointTuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: checkpointId,
        },
      },
      checkpoint: deserializedCheckpoint,
      metadata,
      pendingWrites: pendingWrites as CheckpointTuple["pendingWrites"],
    };

    if (parentCheckpointId) {
      checkpointTuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: parentCheckpointId,
        },
      };
    }

    return checkpointTuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    await this.ensureSchema();
    const threadId = config.configurable?.thread_id;
    if (!threadId) return;

    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const result = await this.pool.query(
      `SELECT checkpoint_id FROM langgraph_checkpoints
       WHERE thread_id = $1 AND checkpoint_ns = $2
       ORDER BY checkpoint_id DESC`,
      [threadId, checkpointNs],
    );

    let limit = options?.limit;
    for (const row of result.rows) {
      if (limit !== undefined && limit <= 0) break;
      const tuple = await this.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: String(row.checkpoint_id),
        },
      });
      if (tuple) {
        yield tuple;
        if (limit !== undefined) limit -= 1;
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    await this.ensureSchema();
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";

    if (!threadId) {
      throw new Error('Missing "thread_id" in configurable');
    }

    assertSafeStorageKey("thread_id", threadId);
    assertSafeStorageKey("checkpoint_ns", checkpointNamespace, {
      allowEmpty: true,
    });
    assertSafeStorageKey("checkpoint_id", checkpoint.id);

    const [[, serializedCheckpoint], [, serializedMetadata]] = await Promise.all(
      [
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ],
    );

    await this.pool.query(
      `INSERT INTO langgraph_checkpoints (
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        checkpoint_data, metadata_data
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
        parent_checkpoint_id = EXCLUDED.parent_checkpoint_id,
        checkpoint_data = EXCLUDED.checkpoint_data,
        metadata_data = EXCLUDED.metadata_data`,
      [
        threadId,
        checkpointNamespace,
        checkpoint.id,
        config.configurable?.checkpoint_id ?? null,
        serializedCheckpoint,
        serializedMetadata,
      ],
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    await this.ensureSchema();
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (!threadId || !checkpointId) {
      throw new Error("Missing thread_id or checkpoint_id in configurable");
    }

    assertSafeStorageKey("thread_id", threadId);
    assertSafeStorageKey("checkpoint_ns", checkpointNamespace, {
      allowEmpty: true,
    });
    assertSafeStorageKey("checkpoint_id", checkpointId);
    assertSafeStorageKey("task_id", taskId);

    const outerKey = generateWriteKey(
      threadId,
      checkpointNamespace,
      checkpointId,
    );

    await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [, serializedValue] = await this.serde.dumpsTyped(value);
        const innerKey = `${taskId},${WRITES_IDX_MAP[channel] ?? idx}`;
        await this.pool.query(
          `INSERT INTO langgraph_writes (
            outer_key, inner_key, task_id, channel, value_data
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (outer_key, inner_key) DO NOTHING`,
          [outerKey, innerKey, taskId, channel, serializedValue],
        );
      }),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ensureSchema();
    assertSafeStorageKey("thread_id", threadId);
    const checkpoints = await this.pool.query(
      `SELECT checkpoint_ns, checkpoint_id FROM langgraph_checkpoints
       WHERE thread_id = $1`,
      [threadId],
    );

    for (const cp of checkpoints.rows) {
      const outerKey = generateWriteKey(
        threadId,
        String(cp.checkpoint_ns),
        String(cp.checkpoint_id),
      );
      await this.pool.query(`DELETE FROM langgraph_writes WHERE outer_key = $1`, [
        outerKey,
      ]);
    }

    await this.pool.query(
      `DELETE FROM langgraph_checkpoints WHERE thread_id = $1`,
      [threadId],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    try {
      await this.ensureSchema();
      await this.pool.query("SELECT 1");
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }

  private async migratePendingSends(
    mutableCheckpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const parentKey = generateWriteKey(
      threadId,
      checkpointNs,
      parentCheckpointId,
    );
    const writeResult = await this.pool.query(
      `SELECT value_data FROM langgraph_writes
       WHERE outer_key = $1 AND channel = $2`,
      [parentKey, TASKS],
    );

    const pendingSends = await Promise.all(
      writeResult.rows.map((row) =>
        this.serde.loadsTyped("json", String(row.value_data)),
      ),
    );

    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = pendingSends;
  }
}

export function resolveCheckpointConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CHECKPOINT_DATABASE_URL) return env.CHECKPOINT_DATABASE_URL;
  if (env.HISTORY_DATABASE_URL) return env.HISTORY_DATABASE_URL;
  return resolvePostgresAuditConnectionFromEnv(env);
}
