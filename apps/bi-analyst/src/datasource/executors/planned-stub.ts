import type { ExecutionResult } from "../../entities.js";
import type {
  DialectFamily,
  HealthStatus,
  SqlExecutionRequest,
  SqlExecutor,
} from "../types.js";

/**
 * 占位执行器：接口齐备，执行时明确拒绝。
 * - oracle/tsql：未注入客户端时回退本 stub（注入后走 OracleExecutor / SqlServerExecutor）
 * - db2/hana：尚无 Executor 实现
 */
export class PlannedDialectExecutor implements SqlExecutor {
  constructor(
    private readonly options: {
      dataSourceId: string;
      dialectFamily: DialectFamily;
      productType?: string;
    },
  ) {}

  async execute(
    _request: SqlExecutionRequest,
    _signal: AbortSignal,
  ): Promise<ExecutionResult> {
    return {
      rows: [],
      columns: [],
      isEmpty: true,
      error: this.message(),
      failureKind: "policy_rejected",
    };
  }

  async explain(_sql: string): Promise<string> {
    throw new Error(this.message());
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: false,
      message: this.message(),
    };
  }

  async close(): Promise<void> {}

  private message(): string {
    const product = this.options.productType
      ? `（${this.options.productType}）`
      : "";
    const dialect = this.options.dialectFamily;
    if (dialect === "oracle" || dialect === "tsql") {
      return (
        `方言 ${dialect}${product}：未注入查询客户端。` +
        `请注入 OracleQueryClient/SqlServerQueryClient，或安装可选驱动 oracledb/tedious。` +
        `LogicalQuery 编译/AST 可用；Docker live 与 production-certified 未完成。`
      );
    }
    return (
      `方言 ${dialect}${product} 仍为 planned：` +
      `LogicalQuery 编译/校验可用，Executor 连库认证未完成`
    );
  }
}

/** 无独立 Executor 实现、或缺客户端时回退 stub 的方言族 */
export const PLANNED_DIALECT_FAMILIES: ReadonlySet<DialectFamily> = new Set([
  "oracle",
  "tsql",
  "db2",
  "hana",
]);

export function isPlannedDialectFamily(dialect: DialectFamily): boolean {
  return PLANNED_DIALECT_FAMILIES.has(dialect);
}
