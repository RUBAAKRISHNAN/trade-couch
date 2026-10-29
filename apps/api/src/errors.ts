/** An expected, user-facing error. The central error handler turns it into a JSON response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
