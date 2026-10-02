import { createVectorStore } from "./vectorStore";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  filename: string;
  text: string;
  /** Reciprocal-rank-fusion score across keyword and vector rankings. */
  score: number;
  via: Array<"keyword" | "vector">;
}

const STOPWORDS = new Set(
  "a an and are as at be by can did do does for from has have how i in is it its me my of on or our please tell than that the their them then there these this to was we what when where which who why will with you your about according document documents uploaded file files".split(
    " ",
  ),
);
const RRF_K = 60;
const MIN_VECTOR_SCORE = 0.3;

/** Turns a question into an FTS5 query: significant terms, quoted, OR-ed. */
export function ftsQuery(text: string): string | null {
  const terms = [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []).filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ].slice(0, 12);
  return terms.length ? terms.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ") : null;
}

/**
 * Hybrid retrieval over a user's document chunks:
 * - keyword: D1 FTS5 with BM25 ranking, searchable as soon as a chunk is written
 * - vector: Vectorize semantic search, available once Vectorize applies the upsert
 * Rankings are merged with reciprocal rank fusion, so a chunk found by both ranks highest.
 */
export async function retrieveChunks(
  env: Env,
  input: { userId: string; question: string; vector: number[] | undefined; topK: number },
): Promise<{ chunks: RetrievedChunk[]; keywordHits: number; vectorScores: number[] }> {
  const query = ftsQuery(input.question);
  const [keyword, vector] = await Promise.all([
    query
      ? env.DB.prepare(
          `SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? AND user_id = ? ORDER BY bm25(chunks_fts) LIMIT ?`,
        )
          .bind(query, input.userId, input.topK * 2)
          .all<{ chunk_id: string }>()
          .then((r) => r.results.map((row) => row.chunk_id))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]),
    input.vector
      ? createVectorStore(env).query(input.userId, input.vector, { topK: input.topK * 2, kind: "doc" })
      : Promise.resolve([]),
  ]);
  const vectorIds = vector.filter((m) => m.score >= MIN_VECTOR_SCORE).map((m) => m.id);

  const fused = new Map<string, { score: number; via: Set<"keyword" | "vector"> }>();
  const add = (ids: string[], via: "keyword" | "vector") =>
    ids.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, via: new Set() };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.via.add(via);
      fused.set(id, entry);
    });
  add(keyword, "keyword");
  add(vectorIds, "vector");

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, input.topK);
  if (ranked.length === 0) return { chunks: [], keywordHits: 0, vectorScores: vector.map((m) => m.score) };

  const ids = ranked.map(([id]) => id);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.text, c.document_id, d.filename
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.user_id = ? AND c.id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(input.userId, ...ids)
    .all<{ id: string; text: string; document_id: string; filename: string }>();
  const rows = new Map(results.map((r) => [r.id, r]));

  const chunks = ranked
    .map(([id, entry]) => {
      const row = rows.get(id);
      return row
        ? { id, documentId: row.document_id, filename: row.filename, text: row.text, score: entry.score, via: [...entry.via] }
        : undefined;
    })
    .filter((c): c is RetrievedChunk => c !== undefined);
  return { chunks, keywordHits: keyword.length, vectorScores: vector.map((m) => m.score) };
}
