import { Data } from "effect"
export class AppError extends Data.TaggedError("AppError")<{ readonly status: number; readonly code: string; readonly message: string; readonly retryAfter?: number }> {}
export const unauthorized = () => new AppError({ status: 401, code: "UNAUTHORIZED", message: "Authentication is required or invalid." })
export const notFound = () => new AppError({ status: 404, code: "NOT_FOUND", message: "Resource not found." })
export const forbidden = () => new AppError({ status: 403, code: "FORBIDDEN", message: "This operation is not permitted." })
export const conflict = (code: string, message: string) => new AppError({ status: 409, code, message })
export const invalid = () => new AppError({ status: 400, code: "INVALID_INPUT", message: "Invalid request input." })
export const limited = (seconds = 1) => new AppError({ status: 429, code: "RATE_LIMITED", message: "Too many requests. Try again later.", retryAfter: seconds })
