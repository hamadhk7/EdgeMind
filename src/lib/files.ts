/**
 * Blob storage for uploaded documents and research reports.
 *
 * Uses R2 when a `FILES` bucket binding is configured, otherwise KV. KV keeps the
 * project deployable on a Workers Free account without enabling R2 (values up to
 * 25 MiB, 1 GB total, 1,000 writes/day on Free). To switch to R2, add
 *   "r2_buckets": [{ "binding": "FILES", "bucket_name": "edgemind-files" }]
 * to wrangler.jsonc; no code changes needed.
 */

export interface StoredFile {
  contentType: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileStore {
  readonly kind: "r2" | "kv";
  put(key: string, value: ReadableStream | ArrayBuffer | string, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  deletePrefix(prefix: string): Promise<void>;
  ping(): Promise<void>;
}

const KV_PREFIX = "file:";

class R2FileStore implements FileStore {
  readonly kind = "r2";
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, value: ReadableStream | ArrayBuffer | string, contentType: string): Promise<void> {
    await this.bucket.put(key, value, { httpMetadata: { contentType } });
  }

  async get(key: string): Promise<StoredFile | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      text: () => object.text(),
      arrayBuffer: () => object.arrayBuffer(),
    };
  }

  async deletePrefix(prefix: string): Promise<void> {
    const listed = await this.bucket.list({ prefix });
    if (listed.objects.length) await this.bucket.delete(listed.objects.map((o) => o.key));
  }

  async ping(): Promise<void> {
    await this.bucket.head("health/probe");
  }
}

class KVFileStore implements FileStore {
  readonly kind = "kv";
  constructor(private readonly kv: KVNamespace) {}

  async put(key: string, value: ReadableStream | ArrayBuffer | string, contentType: string): Promise<void> {
    await this.kv.put(KV_PREFIX + key, value, { metadata: { contentType } });
  }

  async get(key: string): Promise<StoredFile | null> {
    const { value, metadata } = await this.kv.getWithMetadata<{ contentType?: string }>(KV_PREFIX + key, "arrayBuffer");
    if (!value) return null;
    return {
      contentType: metadata?.contentType ?? "application/octet-stream",
      text: async () => new TextDecoder().decode(value),
      arrayBuffer: async () => value,
    };
  }

  async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: KV_PREFIX + prefix, cursor });
      await Promise.all(page.keys.map((k) => this.kv.delete(k.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  async ping(): Promise<void> {
    await this.kv.get("health:probe");
  }
}

export function createFileStore(env: Env): FileStore {
  const bucket = (env as unknown as { FILES?: R2Bucket }).FILES;
  return bucket ? new R2FileStore(bucket) : new KVFileStore(env.KV);
}
