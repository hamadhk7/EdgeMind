import { Hono } from "hono";
import { startOfUtcDay } from "../lib/ids";
import { dailyBudget } from "../lib/usage";
import { type AppEnv, requireAuth } from "./context";

const DAY_MS = 24 * 60 * 60 * 1000;

export const usageRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /** Token and cost usage: today vs budget, the last 7 days by agent and model, and recent calls. */
  .get("/", async (c) => {
    const principal = c.get("principal");
    const today = startOfUtcDay();
    const weekAgo = today - 6 * DAY_MS;
    const db = c.env.DB;

    const [totals, byAgent, byModel, recent, budget] = await Promise.all([
      db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost,
                  COUNT(*) AS calls
           FROM usage WHERE user_id = ? AND created_at >= ?`,
        )
        .bind(principal.userId, today)
        .first<{ tokens: number; cost: number; calls: number }>(),
      db
        .prepare(
          `SELECT agent, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                  SUM(cost_usd) AS cost, COUNT(*) AS calls, ROUND(AVG(latency_ms)) AS avg_latency_ms
           FROM usage WHERE user_id = ? AND created_at >= ? GROUP BY agent ORDER BY cost DESC`,
        )
        .bind(principal.userId, weekAgo)
        .all(),
      db
        .prepare(
          `SELECT provider, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                  SUM(cost_usd) AS cost, COUNT(*) AS calls, SUM(cached) AS cached_calls
           FROM usage WHERE user_id = ? AND created_at >= ? GROUP BY provider, model ORDER BY cost DESC`,
        )
        .bind(principal.userId, weekAgo)
        .all(),
      db
        .prepare(
          `SELECT agent, provider, model, input_tokens, output_tokens, cost_usd, cached, latency_ms, created_at
           FROM usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
        )
        .bind(principal.userId)
        .all(),
      dailyBudget(c.env, principal.kind),
    ]);

    return c.json({
      today: {
        tokens: totals?.tokens ?? 0,
        costUsd: totals?.cost ?? 0,
        calls: totals?.calls ?? 0,
        dailyBudget: budget,
        remaining: Math.max(0, budget - (totals?.tokens ?? 0)),
      },
      last7Days: { byAgent: byAgent.results, byModel: byModel.results },
      recent: recent.results,
    });
  });
