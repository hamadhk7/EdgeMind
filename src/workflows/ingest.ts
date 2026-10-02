import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { audit } from "../lib/audit";
import { isOffline } from "../lib/config";
import { errorMessage } from "../lib/errors";
import { newId } from "../lib/ids";
import { createLogger } from "../lib/logger";
import { createLLM } from "../llm";
import { chunkText } from "../memory/chunker";
import { createVectorStore } from "../memory/vectorStore";

export interface IngestParams {
  documentId: string;
  userId: string;
  r2Key: string;
  filename: string;
  mime: string;
  traceId: string;
}

const EMBED_BATCH = 32;
const INSERT_BATCH = 50;
const STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" } as const;

const PLAIN_TEXT = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/**
 * Document ingestion as a durable Workflow:
 *   R2 file -> text (Workers AI toMarkdown for PDF/DOCX/HTML) -> chunks in D1
 *   -> embeddings in batches -> Vectorize (namespace = user) -> status "ready".
 * Each batch is its own step, so a failure mid-way retries only that batch.
 */
export class IngestDocumentWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep): Promise<{ chunks: number }> {
    const p = event.payload;
    const log = createLogger({ workflow: "ingest", documentId: p.documentId, traceId: p.traceId });
    try {
      await step.do("mark-processing", () => this.setStatus(p.documentId, "processing"));

      const textKey = await step.do("extract", STEP, () => this.extract(p));
      const total = await step.do("chunk", STEP, () => this.chunk(p, textKey));
      if (total === 0) throw new NonRetryableError("No text could be extracted from this file");

      for (let start = 0; start < total; start += EMBED_BATCH) {
        await step.do(`embed-${start}`, STEP, () => this.embedBatch(p, start));
      }

      await step.do("finalize", async () => {
        await this.env.DB.prepare(`UPDATE documents SET status = 'ready', chunk_count = ?, error = NULL WHERE id = ?`)
          .bind(total, p.documentId)
          .run();
        await audit(this.env.DB, { userId: p.userId, action: "document.ready", target: p.documentId, meta: { chunks: total } });
      });
      log.info("document ingested", { chunks: total });
      return { chunks: total };
    } catch (err) {
      const message = errorMessage(err);
      log.error("ingest failed", { err: message });
      await step.do("mark-failed", () => this.setStatus(p.documentId, "failed", message.slice(0, 500)));
      throw err;
    }
  }

  private async setStatus(documentId: string, status: string, error: string | null = null): Promise<void> {
    await this.env.DB.prepare(`UPDATE documents SET status = ?, error = ? WHERE id = ?`)
      .bind(status, error, documentId)
      .run();
  }

  /** Converts the upload to text and stores it next to the original. Returns the text's R2 key. */
  private async extract(p: IngestParams): Promise<string> {
    const object = await this.env.FILES.get(p.r2Key);
    if (!object) throw new NonRetryableError("Uploaded file is missing from storage");

    let text: string;
    if (PLAIN_TEXT.has(p.mime) || /\.(txt|md|markdown|csv|json)$/i.test(p.filename)) {
      text = await object.text();
    } else if (isOffline(this.env)) {
      // No Workers AI offline: best effort for HTML, reject binary formats.
      if (p.mime !== "text/html") throw new NonRetryableError("Offline mode only ingests text files");
      text = (await object.text()).replace(/<[^>]+>/g, " ");
    } else {
      const blob = new Blob([await object.arrayBuffer()], { type: p.mime });
      const converted = await this.env.AI.toMarkdown({ name: p.filename, blob });
      if (converted.format === "error") throw new NonRetryableError(`Could not convert file: ${converted.error}`);
      text = converted.data;
    }

    const textKey = p.r2Key.replace(/[^/]+$/, "extracted.md");
    await this.env.FILES.put(textKey, text, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    return textKey;
  }

  /** Splits text into chunks stored in D1. Idempotent: re-running replaces earlier chunks. */
  private async chunk(p: IngestParams, textKey: string): Promise<number> {
    const object = await this.env.FILES.get(textKey);
    if (!object) throw new Error("Extracted text is missing");
    const chunks = chunkText(await object.text());

    await this.env.DB.prepare(`DELETE FROM chunks WHERE document_id = ?`).bind(p.documentId).run();
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      await this.env.DB.batch(
        chunks.slice(i, i + INSERT_BATCH).map((text, j) =>
          this.env.DB.prepare(`INSERT INTO chunks (id, document_id, user_id, idx, text) VALUES (?, ?, ?, ?, ?)`).bind(
            newId("chk"),
            p.documentId,
            p.userId,
            i + j,
            text,
          ),
        ),
      );
    }
    return chunks.length;
  }

  private async embedBatch(p: IngestParams, start: number): Promise<number> {
    const { results } = await this.env.DB.prepare(
      `SELECT id, text FROM chunks WHERE document_id = ? AND idx >= ? AND idx < ? ORDER BY idx`,
    )
      .bind(p.documentId, start, start + EMBED_BATCH)
      .all<{ id: string; text: string }>();
    if (!results.length) return 0;

    const llm = createLLM(this.env, { userId: p.userId, agent: "ingest", traceId: p.traceId });
    const vectors = await llm.embed(results.map((r) => r.text));
    await createVectorStore(this.env).upsert(
      p.userId,
      results.map((r, i) => ({
        id: r.id,
        values: vectors[i] ?? [],
        metadata: { kind: "doc" as const, documentId: p.documentId },
      })),
    );
    return results.length;
  }
}
