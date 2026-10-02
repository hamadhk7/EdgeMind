import { Hono } from "hono";
import { isOffline } from "../lib/config";
import { errorMessage } from "../lib/errors";
import { createFileStore } from "../lib/files";
import type { AppEnv } from "./context";

type Check = { ok: boolean; ms: number; error?: string };

async function probe(fn: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: errorMessage(err) };
  }
}

export const healthRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const offline = isOffline(c.env);
  const files = createFileStore(c.env);
  const [d1, kv, fileStore, vectorize] = await Promise.all([
    probe(() => c.env.DB.prepare("SELECT 1").first()),
    probe(() => c.env.KV.get("health:probe")),
    probe(() => files.ping()),
    offline ? Promise.resolve<Check>({ ok: true, ms: 0 }) : probe(() => c.env.VECTORS.describe()),
  ]);
  const checks = { d1, kv, files: { ...fileStore, backend: files.kind }, vectorize };
  const ok = Object.values(checks).every((check) => check.ok);
  return c.json(
    { status: ok ? "ok" : "degraded", offline, environment: c.env.ENVIRONMENT, checks },
    ok ? 200 : 503,
  );
});
