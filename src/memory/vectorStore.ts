import { isOffline } from "../lib/config";

export type VectorKind = "doc" | "memory";

export interface VectorMetadata {
  kind: VectorKind;
  documentId?: string;
  /** Memories store their text inline; document chunks keep text in D1. */
  text?: string;
  createdAt?: number;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

export interface VectorStore {
  upsert(userId: string, records: VectorRecord[]): Promise<void>;
  query(userId: string, vector: number[], options: { topK: number; kind: VectorKind }): Promise<VectorMatch[]>;
  deleteByIds(userId: string, ids: string[]): Promise<void>;
}

/** Vectorize, one namespace per user so queries never cross tenants. */
class VectorizeStore implements VectorStore {
  constructor(private readonly index: VectorizeIndex) {}

  async upsert(userId: string, records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    await this.index.upsert(
      records.map((r) => ({
        id: r.id,
        values: r.values,
        namespace: userId,
        metadata: r.metadata as unknown as Record<string, VectorizeVectorMetadata>,
      })),
    );
  }

  async query(userId: string, vector: number[], { topK, kind }: { topK: number; kind: VectorKind }) {
    const result = await this.index.query(vector, {
      topK,
      namespace: userId,
      filter: { kind },
      returnMetadata: "all",
    });
    return result.matches.map((m) => ({
      id: m.id,
      score: m.score,
      metadata: (m.metadata ?? { kind }) as unknown as VectorMetadata,
    }));
  }

  async deleteByIds(_userId: string, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 100) await this.index.deleteByIds(ids.slice(i, i + 100));
  }
}

/** Brute-force cosine search over a D1 table. Offline mode only (tests, local demo). */
class OfflineVectorStore implements VectorStore {
  constructor(private readonly db: D1Database) {}

  async upsert(userId: string, records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    await this.db.batch(
      records.map((r) =>
        this.db
          .prepare(
            `INSERT OR REPLACE INTO offline_vectors (id, user_id, kind, metadata, vec) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(r.id, userId, r.metadata.kind, JSON.stringify(r.metadata), JSON.stringify(r.values)),
      ),
    );
  }

  async query(userId: string, vector: number[], { topK, kind }: { topK: number; kind: VectorKind }) {
    const { results } = await this.db
      .prepare(`SELECT id, metadata, vec FROM offline_vectors WHERE user_id = ? AND kind = ?`)
      .bind(userId, kind)
      .all<{ id: string; metadata: string; vec: string }>();
    return results
      .map((row) => ({
        id: row.id,
        score: cosine(vector, JSON.parse(row.vec) as number[]),
        metadata: JSON.parse(row.metadata) as VectorMetadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteByIds(userId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.batch(
      ids.map((id) => this.db.prepare(`DELETE FROM offline_vectors WHERE id = ? AND user_id = ?`).bind(id, userId)),
    );
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function createVectorStore(env: Env): VectorStore {
  return isOffline(env) ? new OfflineVectorStore(env.DB) : new VectorizeStore(env.VECTORS);
}
