import type Database from "better-sqlite3";
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

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function initCheckpointSchema(db: Database.Database): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_langgraph_writes_outer
      ON langgraph_writes(outer_key);
  `);
}

/** SQLite 持久化 LangGraph checkpointer（development / 单源闭环） */
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Database.Database) {
    super();
    initCheckpointSchema(db);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    let checkpointId: string | undefined = getCheckpointId(config);

    if (threadId !== undefined) assertSafeStorageKey("thread_id", threadId);
    assertSafeStorageKey("checkpoint_ns", checkpointNs, { allowEmpty: true });
    if (checkpointId) assertSafeStorageKey("checkpoint_id", checkpointId);

    if (!threadId) return undefined;

    if (!checkpointId) {
      const latest = this.db
        .prepare(
          `SELECT checkpoint_id FROM langgraph_checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ?
           ORDER BY checkpoint_id DESC LIMIT 1`,
        )
        .get(threadId, checkpointNs) as { checkpoint_id: string } | undefined;
      checkpointId = latest?.checkpoint_id;
      if (!checkpointId) return undefined;
    }

    const row = this.db
      .prepare(
        `SELECT * FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
      )
      .get(threadId, checkpointNs, checkpointId) as
      | Record<string, unknown>
      | undefined;

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
    const writeRows = this.db
      .prepare(
        `SELECT task_id, channel, value_data FROM langgraph_writes
         WHERE outer_key = ? ORDER BY inner_key`,
      )
      .all(outerKey) as Array<{
      task_id: string;
      channel: string;
      value_data: string;
    }>;

    const pendingWrites = await Promise.all(
      writeRows.map(async (w) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped("json", w.value_data),
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
    const threadId = config.configurable?.thread_id;
    if (!threadId) return;

    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const rows = this.db
      .prepare(
        `SELECT checkpoint_id FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC`,
      )
      .all(threadId, checkpointNs) as Array<{ checkpoint_id: string }>;

    let limit = options?.limit;
    for (const row of rows) {
      if (limit !== undefined && limit <= 0) break;
      const tuple = await this.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.checkpoint_id,
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

    this.db
      .prepare(
        `INSERT INTO langgraph_checkpoints (
          thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          checkpoint_data, metadata_data
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
          parent_checkpoint_id = excluded.parent_checkpoint_id,
          checkpoint_data = excluded.checkpoint_data,
          metadata_data = excluded.metadata_data`,
      )
      .run(
        threadId,
        checkpointNamespace,
        checkpoint.id,
        config.configurable?.checkpoint_id ?? null,
        serializedCheckpoint,
        serializedMetadata,
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
        this.db
          .prepare(
            `INSERT INTO langgraph_writes (
              outer_key, inner_key, task_id, channel, value_data
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(outer_key, inner_key) DO NOTHING`,
          )
          .run(outerKey, innerKey, taskId, channel, serializedValue);
      }),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    assertSafeStorageKey("thread_id", threadId);
    const checkpoints = this.db
      .prepare(
        `SELECT checkpoint_ns, checkpoint_id FROM langgraph_checkpoints
         WHERE thread_id = ?`,
      )
      .all(threadId) as Array<{
      checkpoint_ns: string;
      checkpoint_id: string;
    }>;

    for (const cp of checkpoints) {
      const outerKey = generateWriteKey(
        threadId,
        cp.checkpoint_ns,
        cp.checkpoint_id,
      );
      this.db
        .prepare(`DELETE FROM langgraph_writes WHERE outer_key = ?`)
        .run(outerKey);
    }

    this.db
      .prepare(`DELETE FROM langgraph_checkpoints WHERE thread_id = ?`)
      .run(threadId);
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
    const writeRows = this.db
      .prepare(
        `SELECT value_data FROM langgraph_writes
         WHERE outer_key = ? AND channel = ?`,
      )
      .all(parentKey, TASKS) as Array<{ value_data: string }>;

    const pendingSends = await Promise.all(
      writeRows.map((row) => this.serde.loadsTyped("json", row.value_data)),
    );

    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = pendingSends;
  }
}
