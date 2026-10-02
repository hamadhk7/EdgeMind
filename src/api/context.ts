import type { Context, MiddlewareHandler } from "hono";
import { extractToken, resolvePrincipal } from "../auth/principal";
import { AppError, unauthorized } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { Principal } from "../lib/types";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    traceId: string;
    log: Logger;
    principal: Principal;
  };
}

export type AppContext = Context<AppEnv>;

export function clientIp(c: AppContext): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/** Requires a guest JWT or API key; exposes the caller as `c.get("principal")`. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = await resolvePrincipal(c.env, extractToken(c.req.raw));
  if (!principal) throw unauthorized();
  c.set("principal", principal);
  c.set("log", c.get("log").child({ userId: principal.userId }));
  await next();
};

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Admin endpoints use a static bearer token, compared in constant time. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN?.trim();
  if (!expected) throw new AppError(503, "admin_disabled", "ADMIN_TOKEN is not configured");
  const provided = extractToken(c.req.raw) ?? "";
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) throw unauthorized("Invalid admin token");
  await next();
};
