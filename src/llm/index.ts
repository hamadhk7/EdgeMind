import { isOffline } from "../lib/config";
import { createLogger } from "../lib/logger";
import { FakeLLMClient } from "./fake";
import { GatewayLLMClient } from "./gateway";
import type { LLMClient, LLMContext } from "./types";

export type { ChatMessage, ChatRequest, ChatResult, LLMClient, LLMContext, Purpose } from "./types";
export { extractJson } from "./parse";

export function createLLM(env: Env, ctx: LLMContext): LLMClient {
  if (isOffline(env)) return new FakeLLMClient(env.DB, ctx);
  return new GatewayLLMClient(env, ctx, createLogger({ traceId: ctx.traceId, agent: ctx.agent, runId: ctx.runId }));
}
