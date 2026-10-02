import { newId } from "./ids";
import { createLogger } from "./logger";

export interface AuditEntry {
  userId: string | null;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/** Append-only audit trail. Never throws: auditing must not break the request. */
export async function audit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (id, user_id, action, target, meta_json, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId("aud"),
        entry.userId,
        entry.action,
        entry.target ?? null,
        entry.meta ? JSON.stringify(entry.meta) : null,
        entry.ip ?? null,
        Date.now(),
      )
      .run();
  } catch (err) {
    createLogger().warn("audit write failed", { action: entry.action, err: String(err) });
  }
}
