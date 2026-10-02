import { Hono } from "hono";
import { orchestratorName } from "../auth/principal";
import { notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { type AppEnv, requireAuth } from "./context";

interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

const view = (row: ConversationRow, userId: string) => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  /** WebSocket path for this conversation's OrchestratorAgent. */
  agentPath: `/agents/orchestrator-agent/${orchestratorName(userId, row.id)}`,
});

export const conversationRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", async (c) => {
    const { userId } = c.get("principal");
    const { results } = await c.env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50`,
    )
      .bind(userId)
      .all<ConversationRow>();
    return c.json({ conversations: results.map((r) => view(r, userId)) });
  })

  .post("/", async (c) => {
    const { userId } = c.get("principal");
    const now = Date.now();
    const row: ConversationRow = { id: newId("cnv"), title: "New conversation", created_at: now, updated_at: now };
    await c.env.DB.prepare(`INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(row.id, userId, row.title, now, now)
      .run();
    return c.json({ conversation: view(row, userId) }, 201);
  })

  /** Every subtask the agents ran for this conversation: the trace behind each answer. */
  .get("/:id/tasks", async (c) => {
    const { userId } = c.get("principal");
    const id = c.req.param("id");
    const owned = await c.env.DB.prepare(`SELECT 1 FROM conversations WHERE id = ? AND user_id = ?`).bind(id, userId).first();
    if (!owned) throw notFound("Conversation");
    const { results } = await c.env.DB.prepare(
      `SELECT id, run_id, agent, input, status, error, attempts, created_at, completed_at
       FROM tasks WHERE conversation_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(id, userId)
      .all();
    return c.json({ tasks: results });
  });
