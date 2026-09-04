/**
 * T0.4 会话状态持久化：SQLite checkpointer
 *
 * 为什么必须自己实现：`@langchain/langgraph` 只内置了 `MemorySaver`（进程内、重启即丢）。
 * 清单 158 行要求「进程重启后（换 saver 实例、同一 sqlite 文件）能恢复 checkpoint」，
 * 而 `better-sqlite3` 已经在本包依赖里，所以直接落地一个落盘的 saver。
 *
 * 契约对齐 `@langchain/langgraph-checkpoint` 的 `BaseCheckpointSaver`：
 * 序列化走基类的默认 `JsonPlusSerializer`，本类只负责存储与索引。
 */
import Database from "better-sqlite3";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointMetadata,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

/**
 * 以下四个类型由 `@langchain/langgraph-checkpoint` 定义，但该包是本依赖的传递依赖，
 * 按 pnpm 的严格解析规则不能直接 import。这里做结构化的本地声明，
 * 形状与上游保持一致（T0.4 只需实现存储层，不扩展契约）。
 */
type PendingWrite = [string, unknown];
type ChannelVersions = Record<string, number | string>;
interface CheckpointListOptions {
  limit?: number;
  before?: RunnableConfig;
  filter?: Record<string, unknown>;
}
interface SerializerProtocol {
  dumpsTyped(data: unknown): Promise<[string, Uint8Array]>;
  loadsTyped(type: string, data: Uint8Array | string): Promise<unknown>;
}

/** 防止原型污染的合法 key 校验（对齐 MemorySaver 的守卫） */
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeKey(field: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new Error(
      `Invalid configurable value for key "${field}": expected string (got ${typeof value}).`,
    );
  }
  if (!allowEmpty && value === "") {
    throw new Error(`Invalid configurable value for key "${field}": empty string not permitted.`);
  }
  if (POLLUTION_KEYS.has(value)) {
    throw new Error(`Invalid configurable value for key "${field}": "${value}" is reserved.`);
  }
  return value;
}

interface ConfigParts {
  threadId: string;
  checkpointNs: string;
  checkpointId: string | undefined;
}

function parseConfig(config: RunnableConfig): ConfigParts {
  const c = (config?.configurable ?? {}) as Record<string, unknown>;
  return {
    threadId: safeKey("thread_id", c.thread_id ?? ""),
    checkpointNs: safeKey("checkpoint_ns", c.checkpoint_ns ?? "", true),
    checkpointId: c.checkpoint_id === undefined ? undefined : safeKey("checkpoint_id", c.checkpoint_id),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id      TEXT NOT NULL,
  checkpoint_ns  TEXT NOT NULL DEFAULT '',
  checkpoint_id  TEXT NOT NULL,
  parent_id      TEXT,
  type           TEXT,
  checkpoint     BLOB,
  metadata       BLOB,
  created_at     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE TABLE IF NOT EXISTS writes (
  thread_id     TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  channel       TEXT NOT NULL,
  type          TEXT,
  value         BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_writes_lookup
  ON writes (thread_id, checkpoint_ns, checkpoint_id);
`;

export interface SqliteSaverOptions {
  /** 传 ":memory:" 时用临时库（仅测试 / 单进程开发） */
  path?: string;
  /** 时钟注入：测试用它控制 created_at，验证留存清理边界 */
  clock?: () => number;
}

/** 落盘 checkpointer：进程重启后同一文件可恢复 checkpoint */
export class SqliteSaver extends BaseCheckpointSaver {
  // T8.2 留存清理：实现 RetentionTarget，由 RetentionRunner 按 session TTL 调用 purge
  readonly name = "checkpoint-store";
  readonly kind = "session" as const;

  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(options: SqliteSaverOptions = {}) {
    super();
    this.db = new Database(options.path ?? ":memory:");
    this.clock = options.clock ?? Date.now;
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    // 老库迁移：补 created_at 列。存量记录从迁移时刻起算 TTL（填 0 会导致
    // 升级后第一次清理就把全部存量 checkpoint 当过期删掉）。
    try {
      this.db.exec("ALTER TABLE checkpoints ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    } catch {
      // 新库 exec(SCHEMA) 已带该列——忽略重复列错误
    }
    this.db.prepare("UPDATE checkpoints SET created_at = ? WHERE created_at = 0").run(this.clock());
  }

  /** 显式声明：避免 TS 认为 serde 未初始化（基类构造函数里已赋默认值） */
  declare serde: SerializerProtocol;

  /** 关闭底层连接 */
  close(): void {
    this.db.close();
  }

  private async serialize(value: unknown): Promise<Buffer> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return Buffer.concat([Buffer.from(type, "utf8"), Buffer.from([0]), Buffer.from(bytes)]);
  }

  private async deserialize(raw: Buffer): Promise<unknown> {
    const sep = raw.indexOf(0);
    const type = raw.subarray(0, sep).toString("utf8");
    return this.serde.loadsTyped(type, raw.subarray(sep + 1));
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, checkpointNs, checkpointId } = parseConfig(config);

    const row = checkpointId
      ? this.db
          .prepare(
            `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata
             FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
          )
          .get(threadId, checkpointNs, checkpointId) as Row | undefined
      : (this.db
          .prepare(
            `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata
             FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
             ORDER BY rowid DESC LIMIT 1`,
          )
          .get(threadId, checkpointNs) as Row | undefined);

    if (!row) return undefined;

    const checkpoint = (await this.deserialize(row.checkpoint)) as Checkpoint;
    const metadata = row.metadata
      ? ((await this.deserialize(row.metadata)) as CheckpointMetadata)
      : undefined;

    const parentConfig: RunnableConfig | undefined = row.parent_id
      ? {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: row.parent_id,
          },
        }
      : undefined;

    const writeRows = this.db
      .prepare(
        `SELECT task_id, idx, channel, type, value FROM writes
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         ORDER BY task_id, idx`,
      )
      .all(threadId, checkpointNs, row.checkpoint_id) as WriteRow[];

    // LangGraph v1 的 pendingWrites 形状是 [taskId, channel, value] 三元组
    const pendingWrites: Array<[string, string, unknown]> = [];
    for (const w of writeRows) {
      pendingWrites.push([w.task_id, w.channel, await this.deserialize(w.value)]);
    }

    return {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      parentConfig,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { threadId, checkpointNs } = parseConfig(config);
    const limit = options?.limit ?? 50;

    const rows = this.db
      .prepare(
        `SELECT checkpoint_id FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(threadId, checkpointNs, limit) as Array<{ checkpoint_id: string }>;

    for (const r of rows) {
      const tuple = await this.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: r.checkpoint_id,
        },
      });
      if (tuple) yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const { threadId, checkpointNs } = parseConfig(config);
    const parentId =
      (config.configurable as Record<string, unknown> | undefined)?.checkpoint_id as
        | string
        | undefined;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        checkpointNs,
        checkpoint.id,
        parentId ?? null,
        "json",
        await this.serialize(checkpoint),
        await this.serialize(metadata),
        this.clock(),
      );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const { threadId, checkpointNs, checkpointId } = parseConfig(config);
    if (!checkpointId) {
      throw new Error("putWrites requires checkpoint_id in config.configurable");
    }

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // PendingWrite 是 [channel, value] 二元组（见文件头类型声明与
    // @langchain/langgraph-checkpoint 的 `type PendingWrite<Channel> = [Channel, Value]`）。
    // taskId 由本方法单独入参给出；getTuple 返回的 CheckpointPendingWrite 才是三元组
    // [taskId, channel, value]——两者形状不同，不要互相套用。
    const entries = writes as PendingWrite[];
    for (let idx = 0; idx < entries.length; idx++) {
      const [channel, value] = entries[idx];
      const [type, bytes] = await this.serde.dumpsTyped(value);
      stmt.run(
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        idx,
        channel,
        type,
        Buffer.from(bytes),
      );
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(threadId);
    this.db.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(threadId);
  }

  /**
   * T8.2 留存清理（RetentionTarget）：删除 created_at 早于 cutoff 的 checkpoint
   * 及其孤儿 writes，返回删除的 checkpoint 数。
   * writes 表未启用外键级联（避免压垮 checkpoint 写入路径），手工清理孤儿行。
   */
  purge(olderThanMs: number): number {
    const { changes } = this.db
      .prepare(`DELETE FROM checkpoints WHERE created_at < ?`)
      .run(olderThanMs);
    this.db
      .prepare(
        `DELETE FROM writes
         WHERE checkpoint_id NOT IN (SELECT checkpoint_id FROM checkpoints)`,
      )
      .run();
    return changes;
  }
}

interface Row {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_id: string | null;
  type: string | null;
  checkpoint: Buffer;
  metadata: Buffer | null;
}

interface WriteRow {
  task_id: string;
  idx: number;
  channel: string;
  type: string | null;
  value: Buffer;
}
