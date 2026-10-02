import type { AgentKind } from "../lib/types";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** What a call is for. Drives default model choice, gateway metadata and the offline fake. */
export type Purpose =
  | "plan"
  | "direct"
  | "research"
  | "research_queries"
  | "research_reflect"
  | "report"
  | "rag"
  | "code"
  | "synthesize"
  | "memory";

export interface ChatRequest {
  purpose: Purpose;
  messages: ChatMessage[];
  /** Overrides the model configured for this purpose. */
  model?: string;
  /** Ask for a JSON object response. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Seconds AI Gateway may serve this exact request from cache. */
  cacheTtl?: number;
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  latencyMs: number;
}

/** Who is calling; attached to every request as AI Gateway metadata and usage rows. */
export interface LLMContext {
  userId: string;
  agent: AgentKind;
  traceId: string;
  conversationId?: string;
  runId?: string;
}

export interface LLMClient {
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Streams text deltas. Usage is recorded when the stream finishes. */
  stream(req: ChatRequest): Promise<ReadableStream<string>>;
  embed(texts: string[]): Promise<number[][]>;
}
