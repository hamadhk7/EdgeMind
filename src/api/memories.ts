import { getAgentByName } from "agents";
import { Hono } from "hono";
import type { SummarizerAgent } from "../agents/summarizer";
import { notFound } from "../lib/errors";
import { createFileStore } from "../lib/files";
import { type AppEnv, requireAuth } from "./context";

function summarizer(env: Env, userId: string) {
  return getAgentByName(env.SummarizerAgent as unknown as DurableObjectNamespace<SummarizerAgent>, userId);
}

export const memoryRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /** Long-term facts the agents remember about the caller. */
  .get("/", async (c) => {
    const { userId } = c.get("principal");
    const memories = await (await summarizer(c.env, userId)).listMemories();
    return c.json({ memories });
  })

  .delete("/:id", async (c) => {
    const { userId } = c.get("principal");
    const removed = await (await summarizer(c.env, userId)).forgetMemory(userId, c.req.param("id"));
    if (!removed) throw notFound("Memory");
    return c.body(null, 204);
  });

export const reportRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /** Markdown report written by DeepResearchWorkflow. */
  .get("/:runId", async (c) => {
    const { userId } = c.get("principal");
    const object = await createFileStore(c.env).get(`reports/${userId}/${c.req.param("runId")}.md`);
    if (!object) throw notFound("Report");
    return new Response(await object.text(), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename="edgemind-report-${c.req.param("runId")}.md"`,
      },
    });
  });
