import type { Principal } from "../lib/types";
import { isApiKey, lookupApiKey } from "./apiKeys";
import { verifyJwt } from "./jwt";

/**
 * Reads a bearer token from the Authorization header, falling back to the
 * `token` query parameter (browsers cannot set headers on WebSocket upgrades).
 */
export function extractToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return new URL(request.url).searchParams.get("token");
}

export async function resolvePrincipal(env: Env, token: string | null): Promise<Principal | null> {
  if (!token) return null;
  if (isApiKey(token)) return lookupApiKey(env, token);
  const claims = await verifyJwt(token, env.JWT_SECRET);
  return claims ? { userId: claims.sub, kind: claims.kind } : null;
}

/** Orchestrator instances are named `<userId>__<conversationId>`. */
export function orchestratorName(userId: string, conversationId: string): string {
  return `${userId}__${conversationId}`;
}

export function parseOrchestratorName(name: string): { userId: string; conversationId: string } | null {
  const [userId, conversationId, ...rest] = name.split("__");
  if (!userId || !conversationId || rest.length > 0) return null;
  return { userId, conversationId };
}
