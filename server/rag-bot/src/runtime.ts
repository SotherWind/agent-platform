import Database from "better-sqlite3";

export class NativeRuntimeCompatibilityError extends Error {
  readonly code = "native_runtime_mismatch";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NativeRuntimeCompatibilityError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * better-sqlite3 only loads its native binary when a Database is constructed.
 * Check that boundary before opening the deployment's real SQLite files so a
 * Node/dependency mismatch becomes a clear startup failure.
 */
export function assertNativeRuntimeCompatibility(): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(":memory:");
    db.prepare("SELECT 1").get();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (errorCode(error) === "ERR_DLOPEN_FAILED" || message.includes("NODE_MODULE_VERSION")) {
      throw new NativeRuntimeCompatibilityError(
        [
          "better-sqlite3 与当前 Node.js 运行时不兼容。",
          `Node=${process.version}`,
          `NODE_MODULE_VERSION=${process.versions.modules}`,
          `Node-ABI 错误=${message}`,
          "请切换到项目固定的 Node 22.14.0 后，在仓库根目录重新执行 pnpm install。",
        ].join(" "),
        { cause: error },
      );
    }
    throw error;
  } finally {
    db?.close();
  }
}
