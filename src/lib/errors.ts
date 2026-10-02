import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = (message = "Missing or invalid credentials") =>
  new AppError(401, "unauthorized", message);

export const forbidden = (message = "Not allowed") => new AppError(403, "forbidden", message);

export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);

export const badRequest = (message: string) => new AppError(400, "bad_request", message);

export const rateLimited = (message = "Too many requests, slow down") =>
  new AppError(429, "rate_limited", message);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
