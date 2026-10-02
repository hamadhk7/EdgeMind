import type { Principal } from "../lib/types";

const KEY_PREFIX = "em_";
const CACHE_TTL_SECONDS = 300;

export function isApiKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return KEY_PREFIX + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface CachedKey {
  userId: string;
  keyId: string;
}

/**
 * Resolves an API key to its user. Only the SHA-256 hash is stored; lookups are
 * cached in KV for five minutes, so revocation takes effect within that window
 * (revoke also deletes the cache entry, making it immediate in practice).
 */
export async function lookupApiKey(env: Env, key: string): Promise<Principal | null> {
  const hash = await sha256Hex(key);
  const cacheKey = `apikey:${hash}`;
  const cached = await env.KV.get<CachedKey>(cacheKey, "json");
  if (cached) return { userId: cached.userId, kind: "key" };

  const row = await env.DB.prepare(
    `SELECT id, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
  )
    .bind(hash)
    .first<{ id: string; user_id: string }>();
  if (!row) return null;

  await Promise.all([
    env.KV.put(cacheKey, JSON.stringify({ userId: row.user_id, keyId: row.id } satisfies CachedKey), {
      expirationTtl: CACHE_TTL_SECONDS,
    }),
    env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(Date.now(), row.id).run(),
  ]);
  return { userId: row.user_id, kind: "key" };
}
