export type AppErrorCode =
  | "config_invalid"
  | "unauthenticated"
  | "forbidden"
  | "session_invalid"
  | "missing_request_context"
  | "deadline_exceeded"
  | "internal_error"
  | "validation_error";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: AppErrorCode,
    public readonly statusCode = 500,
    public readonly expose = true,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toClientError(error: unknown): {
  statusCode: number;
  body: { error: string; code: string };
} {
  if (error instanceof AppError && error.expose) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: "内部服务错误",
      code: "internal_error",
    },
  };
}
