import { getConfig } from "./config";
import { AppError } from "./errors";
import { newId, startOfUtcDay } from "./ids";
import type { Principal } from "./types";

/** USD per million tokens [input, output]. Estimates for the cost dashboard, not billing. */
const PRICES: Record<string, [number, number]> = {
  "@cf/zai-org/glm-4.7-flash": [0.06, 0.4],
  "@cf/google/gemma-4-26b-a4b-it": [0.1, 0.3],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [0.293, 2.253],
  "@cf/baai/bge-base-en-v1.5": [0.067, 0],
  "claude-opus-5-5": [4, 20],
  "gpt-5-mini": [0.25, 2],
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const [inPrice, outPrice] = PRICES[model] ?? [0, 0];
  return (inputTokens * inPrice + outputTokens * outPrice) / 1_000_000;
}

/** Rough token estimate when a provider does not report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface UsageRow {
  userId: string;
  conversationId?: string;
  agent: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  latencyMs: number;
}

export async function recordUsage(db: D1Database, row: UsageRow): Promise<void> {
  const cost = estimateCost(row.model, row.inputTokens, row.outputTokens);
  await db
    .prepare(
      `INSERT INTO usage (id, user_id, conversation_id, agent, provider, model,
         input_tokens, output_tokens, cost_usd, cached, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("use"),
      row.userId,
      row.conversationId ?? null,
      row.agent,
      row.provider,
      row.model,
      row.inputTokens,
      row.outputTokens,
      cost,
      row.cached ? 1 : 0,
      row.latencyMs,
      Date.now(),
    )
    .run();
}

export async function tokensUsedToday(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
       FROM usage WHERE user_id = ? AND created_at >= ?`,
    )
    .bind(userId, startOfUtcDay())
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function dailyBudget(env: Env, kind: Principal["kind"]): Promise<number> {
  const { limits } = await getConfig(env);
  return kind === "guest" ? limits.guestDailyTokens : limits.keyDailyTokens;
}

/** Throws a 429 when the user has spent their daily token budget. */
export async function assertWithinBudget(env: Env, principal: Principal): Promise<void> {
  const [used, budget] = await Promise.all([
    tokensUsedToday(env.DB, principal.userId),
    dailyBudget(env, principal.kind),
  ]);
  if (used >= budget) {
    throw new AppError(
      429,
      "budget_exceeded",
      `Daily token budget reached (${used}/${budget}). Resets at 00:00 UTC.`,
    );
  }
}
