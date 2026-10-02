import { Hono } from "hono";
import { z } from "zod";
import { generateApiKey, sha256Hex } from "../auth/apiKeys";
import { audit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { type AppEnv, clientIp, requireAdmin } from "./context";

const CreateKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Attach the key to an existing user; omit to create a new one. */
  userId: z.string().trim().optional(),
});

export const adminRoutes = new Hono<AppEnv>()
  .use(requireAdmin)

  /** Issues an API key. The plaintext key is returned once and only its SHA-256 hash is stored. */
  .post("/keys", async (c) => {
    const body = CreateKeySchema.parse(await c.req.json().catch(() => ({})));
    const now = Date.now();
    let userId = body.userId;
    if (userId) {
      const user = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first();
      if (!user) throw notFound("User");
    } else {
      userId = newId("usr");
      await c.env.DB.prepare(`INSERT INTO users (id, kind, created_at) VALUES (?, 'key', ?)`).bind(userId, now).run();
    }

    const apiKey = generateApiKey();
    const keyId = newId("key");
    await c.env.DB.prepare(
      `INSERT INTO api_keys (id, user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(keyId, userId, body.name, await sha256Hex(apiKey), now)
      .run();
    await audit(c.env.DB, { userId, action: "api_key.created", target: keyId, meta: { name: body.name }, ip: clientIp(c) });
    return c.json({ keyId, userId, name: body.name, apiKey }, 201);
  })

  .delete("/keys/:id", async (c) => {
    const keyId = c.req.param("id");
    const row = await c.env.DB.prepare(`SELECT user_id, key_hash FROM api_keys WHERE id = ? AND revoked_at IS NULL`)
      .bind(keyId)
      .first<{ user_id: string; key_hash: string }>();
    if (!row) throw notFound("API key");
    await c.env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).bind(Date.now(), keyId).run();
    await c.env.KV.delete(`apikey:${row.key_hash}`);
    await audit(c.env.DB, { userId: row.user_id, action: "api_key.revoked", target: keyId, ip: clientIp(c) });
    return c.body(null, 204);
  })

  .get("/audit", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const { results } = await c.env.DB.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`)
      .bind(limit)
      .all();
    return c.json({ entries: results });
  });
