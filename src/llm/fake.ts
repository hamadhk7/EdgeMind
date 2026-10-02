import { EMBEDDING_DIMENSIONS } from "../lib/config";
import { estimateTokens, recordUsage } from "../lib/usage";
import type { ChatRequest, ChatResult, LLMClient, LLMContext } from "./types";

/**
 * Deterministic stand-in for Workers AI, used in tests and `npm run dev:offline`.
 * Responses depend only on the request purpose and text, so flows are reproducible.
 * Include "[fail]" in a research instruction to simulate a failing agent.
 */
export class FakeLLMClient implements LLMClient {
  constructor(
    private readonly db: D1Database,
    private readonly ctx: LLMContext,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const text = respond(req);
    const result: ChatResult = {
      text,
      provider: "offline",
      model: "offline-fake",
      inputTokens: estimateTokens(req.messages.map((m) => m.content).join("\n")),
      outputTokens: estimateTokens(text),
      cached: false,
      latencyMs: 1,
    };
    await recordUsage(this.db, {
      userId: this.ctx.userId,
      conversationId: this.ctx.conversationId,
      agent: this.ctx.agent,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cached: false,
      latencyMs: 1,
    });
    return result;
  }

  async stream(req: ChatRequest): Promise<ReadableStream<string>> {
    const { text } = await this.chat(req);
    const words = text.split(/(?<=\s)/);
    return new ReadableStream<string>({
      start(controller) {
        for (const word of words) controller.enqueue(word);
        controller.close();
      },
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(hashEmbedding);
  }
}

function lastUser(req: ChatRequest): string {
  return [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

/** The planner prompt carries the raw request after this marker. */
function requestText(req: ChatRequest): string {
  const text = lastUser(req);
  const marker = text.indexOf("REQUEST:");
  return (marker === -1 ? text : text.slice(marker + "REQUEST:".length)).trim();
}

function respond(req: ChatRequest): string {
  const input = lastUser(req);
  switch (req.purpose) {
    case "plan":
      return JSON.stringify(fakePlan(req));
    case "direct":
      return "Hello! I'm EdgeMind running in offline mode, so answers come from a deterministic stand-in model.";
    case "research":
      if (input.includes("[fail]")) throw new Error("Simulated research failure");
      return `Findings: the sources describe ${requestText(req).slice(0, 80)} in detail [1].`;
    case "research_queries":
      return JSON.stringify({ queries: ["overview", "recent developments"] });
    case "research_reflect":
      return JSON.stringify({ done: true, gaps: [] });
    case "report":
      return "# Research report\n\nOffline mode report built from the collected notes [1].";
    case "rag":
      return "According to your documents, the answer is covered in the retrieved passage [1].";
    case "code":
      return "```ts\nexport function example(): string {\n  return \"offline\";\n}\n```";
    case "synthesize":
      return "Here is the combined answer from the specialist agents [1].";
    case "memory": {
      const name = input.match(/my name is (\w+)/i)?.[1];
      return JSON.stringify({ facts: name ? [`The user's name is ${name}.`] : [] });
    }
  }
}

function fakePlan(req: ChatRequest) {
  const request = requestText(req);
  const lower = request.toLowerCase();
  const docCount = Number(req.messages.map((m) => m.content).join("\n").match(/Uploaded documents: (\d+)/)?.[1] ?? 0);

  if (/deep research|in-depth|comprehensive report/.test(lower)) {
    return { mode: "deep_research", rationale: "User asked for in-depth research.", subtasks: [] };
  }
  if (/^(hi|hello|hey|thanks|thank you)\b/.test(lower)) {
    return { mode: "direct", rationale: "Small talk.", subtasks: [] };
  }
  const subtasks: Array<{ id: string; agent: string; input: string; dependsOn: string[] }> = [
    { id: "t1", agent: "research", input: request.split(/\s+/).slice(0, 8).join(" "), dependsOn: [] },
  ];
  if (docCount > 0) subtasks.push({ id: "t2", agent: "rag", input: request, dependsOn: [] });
  if (/\b(code|function|script|typescript|python|implement)\b/.test(lower)) {
    subtasks.push({ id: "t3", agent: "code", input: `Write code for: ${request}`, dependsOn: ["t1"] });
  }
  return { mode: "delegate", rationale: "Needs lookup before answering.", subtasks };
}

/** Bag-of-words hashing embedding: texts sharing words get similar vectors. */
export function hashEmbedding(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) {
      h ^= word.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = (h >>> 0) % EMBEDDING_DIMENSIONS;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}
