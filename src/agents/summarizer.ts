import { Agent } from "agents";
import { errorMessage } from "../lib/errors";
import { newId } from "../lib/ids";
import { createLogger } from "../lib/logger";
import type { Source } from "../lib/types";
import { createLLM, extractJson, type LLMContext } from "../llm";
import { memoryMessages, synthesisMessages } from "../llm/prompts";
import { createVectorStore } from "../memory/vectorStore";

export interface SynthesisInput {
  userId: string;
  conversationId: string;
  traceId: string;
  runId: string;
  question: string;
  history: string;
  memories: string[];
  results: Array<{ agent: string; status: string; output: string }>;
  sources: Source[];
}

export interface DistillInput {
  userId: string;
  conversationId: string;
  traceId: string;
  runId: string;
  question: string;
  answer: string;
}

const MAX_FACTS = 3;

/**
 * Merges specialist results into the final answer (streamed back over RPC) and
 * distils durable facts about the user into long-term memory (Vectorize).
 * One instance per user.
 */
export class SummarizerAgent extends Agent<Env> {
  private tablesReady = false;

  private ensureTables(): void {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      conversation_id TEXT,
      created_at INTEGER NOT NULL
    )`;
    this.tablesReady = true;
  }

  private context(input: { userId: string; conversationId: string; traceId: string; runId: string }): LLMContext {
    return { ...input, agent: "summarizer" };
  }

  /** Returns UTF-8 bytes of the answer as it is generated. */
  async synthesize(input: SynthesisInput): Promise<ReadableStream<Uint8Array>> {
    const llm = createLLM(this.env, this.context(input));
    const text = await llm.stream({
      purpose: "synthesize",
      messages: synthesisMessages(input),
      maxTokens: 1500,
      temperature: 0.3,
    });
    return text.pipeThrough(new TextEncoderStream());
  }

  async distillMemories(input: DistillInput): Promise<string[]> {
    this.ensureTables();
    const log = createLogger({ agent: "summarizer", traceId: input.traceId, runId: input.runId });
    const existing = this.sql<{ text: string }>`SELECT text FROM memories ORDER BY created_at DESC LIMIT 20`.map(
      (r) => r.text,
    );
    const llm = createLLM(this.env, this.context(input));
    const result = await llm.chat({
      purpose: "memory",
      messages: memoryMessages({ question: input.question, answer: input.answer, existing }),
      json: true,
      maxTokens: 300,
      temperature: 0,
    });

    const known = new Set(existing.map((f) => f.toLowerCase()));
    const raw = (extractJson(result.text) as { facts?: unknown } | undefined)?.facts;
    const facts = (Array.isArray(raw) ? raw : [])
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim().slice(0, 300))
      .filter((f) => f && !known.has(f.toLowerCase()))
      .slice(0, MAX_FACTS);
    if (facts.length === 0) return [];

    try {
      const vectors = await llm.embed(facts);
      const now = Date.now();
      const records = facts.map((text, i) => ({
        id: newId("mem"),
        values: vectors[i] ?? [],
        metadata: { kind: "memory" as const, text, createdAt: now },
      }));
      await createVectorStore(this.env).upsert(input.userId, records);
      for (const r of records) {
        this.sql`INSERT INTO memories (id, text, conversation_id, created_at)
          VALUES (${r.id}, ${r.metadata.text}, ${input.conversationId}, ${now})`;
      }
      log.info("memories stored", { count: facts.length });
      return facts;
    } catch (err) {
      log.warn("memory store failed", { err: errorMessage(err) });
      return [];
    }
  }

  async listMemories(): Promise<Array<{ id: string; text: string; createdAt: number }>> {
    this.ensureTables();
    return this.sql<{ id: string; text: string; created_at: number }>`
      SELECT id, text, created_at FROM memories ORDER BY created_at DESC LIMIT 100`.map((r) => ({
      id: r.id,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  async forgetMemory(userId: string, id: string): Promise<boolean> {
    this.ensureTables();
    const [row] = this.sql<{ id: string }>`SELECT id FROM memories WHERE id = ${id}`;
    if (!row) return false;
    await createVectorStore(this.env).deleteByIds(userId, [id]);
    this.sql`DELETE FROM memories WHERE id = ${id}`;
    return true;
  }

  /** Internal agent: never reachable over HTTP/WebSocket. */
  override onRequest(): Response {
    return new Response("Not found", { status: 404 });
  }
}
