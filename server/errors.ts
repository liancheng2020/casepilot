export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function errorResult(error: unknown) {
  if (error instanceof AppError)
    return { code: error.code, message: error.message };
  return {
    code: "INTERNAL_ERROR",
    message: "操作失败，请检查服务端日志或重新核查任务。",
  };
}
