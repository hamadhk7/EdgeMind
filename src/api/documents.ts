import { Hono } from "hono";
import { audit } from "../lib/audit";
import { getConfig } from "../lib/config";
import { AppError, badRequest, notFound, rateLimited } from "../lib/errors";
import { newId } from "../lib/ids";
import { createVectorStore } from "../memory/vectorStore";
import type { IngestParams } from "../workflows/ingest";
import { type AppEnv, clientIp, requireAuth } from "./context";

const TYPES_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

interface DocumentRow {
  id: string;
  filename: string;
  mime: string;
  size: number;
  status: string;
  chunk_count: number;
  error: string | null;
  created_at: number;
  r2_key: string;
}

const view = (d: DocumentRow) => ({
  id: d.id,
  filename: d.filename,
  mime: d.mime,
  size: d.size,
  status: d.status,
  chunkCount: d.chunk_count,
  error: d.error,
  createdAt: d.created_at,
});

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "document").slice(0, 120);
}

export const documentRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /** Upload a file; ingestion runs asynchronously in IngestDocumentWorkflow. */
  .post("/", async (c) => {
    const { userId } = c.get("principal");
    const { success } = await c.env.UPLOAD_LIMITER.limit({ key: `upload:${userId}` });
    if (!success) throw rateLimited("Too many uploads, try again in a minute");

    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") throw badRequest('Send the file as multipart form field "file"');

    const { limits } = await getConfig(c.env);
    if (file.size === 0) throw badRequest("File is empty");
    if (file.size > limits.maxUploadBytes) {
      throw new AppError(413, "too_large", `File exceeds ${Math.round(limits.maxUploadBytes / 1024 / 1024)} MB`);
    }
    const filename = safeFilename(file.name);
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    const mime = TYPES_BY_EXTENSION[extension];
    if (!mime) throw new AppError(415, "unsupported_type", `Supported types: ${Object.keys(TYPES_BY_EXTENSION).join(", ")}`);

    const documentId = newId("doc");
    const r2Key = `docs/${userId}/${documentId}/${filename}`;
    await c.env.FILES.put(r2Key, file.stream(), {
      httpMetadata: { contentType: mime },
      customMetadata: { userId, documentId },
    });
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO documents (id, user_id, filename, mime, size, r2_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
      .bind(documentId, userId, filename, mime, file.size, r2Key, now)
      .run();

    const params: IngestParams = { documentId, userId, r2Key, filename, mime, traceId: c.get("traceId") };
    const instance = await c.env.INGEST_WORKFLOW.create({ id: documentId, params });
    await c.env.DB.prepare(`UPDATE documents SET workflow_id = ? WHERE id = ?`).bind(instance.id, documentId).run();
    await audit(c.env.DB, { userId, action: "document.uploaded", target: documentId, meta: { filename, size: file.size }, ip: clientIp(c) });

    return c.json(
      {
        document: view({
          id: documentId,
          filename,
          mime,
          size: file.size,
          status: "queued",
          chunk_count: 0,
          error: null,
          created_at: now,
          r2_key: r2Key,
        }),
      },
      202,
    );
  })

  .get("/", async (c) => {
    const { userId } = c.get("principal");
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(userId)
      .all<DocumentRow>();
    return c.json({ documents: results.map(view) });
  })

  .get("/:id", async (c) => {
    const { userId } = c.get("principal");
    const doc = await c.env.DB.prepare(`SELECT * FROM documents WHERE id = ? AND user_id = ?`)
      .bind(c.req.param("id"), userId)
      .first<DocumentRow>();
    if (!doc) throw notFound("Document");
    return c.json({ document: view(doc) });
  })

  /** Removes the file, its chunks and its vectors. */
  .delete("/:id", async (c) => {
    const { userId } = c.get("principal");
    const id = c.req.param("id");
    const doc = await c.env.DB.prepare(`SELECT * FROM documents WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<DocumentRow>();
    if (!doc) throw notFound("Document");

    const { results: chunks } = await c.env.DB.prepare(`SELECT id FROM chunks WHERE document_id = ?`)
      .bind(id)
      .all<{ id: string }>();
    await createVectorStore(c.env).deleteByIds(
      userId,
      chunks.map((ch) => ch.id),
    );
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM chunks WHERE document_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(id),
    ]);
    const listed = await c.env.FILES.list({ prefix: `docs/${userId}/${id}/` });
    if (listed.objects.length) await c.env.FILES.delete(listed.objects.map((o) => o.key));
    await audit(c.env.DB, { userId, action: "document.deleted", target: id });
    return c.body(null, 204);
  });
