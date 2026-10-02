import { Hono } from "hono";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { newId } from "../lib/ids";
import { createLogger } from "../lib/logger";
import { adminRoutes } from "./admin";
import type { AppEnv } from "./context";
import { conversationRoutes } from "./conversations";
import { documentRoutes } from "./documents";
import { healthRoutes } from "./health";
import { memoryRoutes, reportRoutes } from "./memories";
import { sessionRoutes } from "./session";
import { usageRoutes } from "./usage";

export function createApp() {
  const app = new Hono<AppEnv>();

  // Every request gets a trace id, echoed back and attached to all log lines.
  app.use("*", async (c, next) => {
    const traceId = c.req.header("x-trace-id") ?? newId("trc");
    c.set("traceId", traceId);
    c.set("log", createLogger({ traceId, method: c.req.method, path: c.req.path }));
    await next();
    c.header("x-trace-id", traceId);
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof ZodError) {
      return c.json(
        { error: { code: "bad_request", message: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } },
        400,
      );
    }
    c.get("log")?.error("unhandled error", { err: err instanceof Error ? err.stack : String(err) });
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

  app.route("/api/health", healthRoutes);
  app.route("/api", sessionRoutes);
  app.route("/api/conversations", conversationRoutes);
  app.route("/api/documents", documentRoutes);
  app.route("/api/usage", usageRoutes);
  app.route("/api/memories", memoryRoutes);
  app.route("/api/reports", reportRoutes);
  app.route("/api/admin", adminRoutes);

  return app;
}
