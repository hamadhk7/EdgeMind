import Anthropic from "@anthropic-ai/sdk";
import { type AppConfig, getConfig, secret } from "../lib/config";
import { AppError, errorMessage } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { estimateTokens, recordUsage } from "../lib/usage";
import { type ParsedCompletion, parseCompletion, singleChunkStream, sseToTextStream } from "./parse";
import type { ChatRequest, ChatResult, LLMClient, LLMContext, Purpose } from "./types";

type Provider = "workers-ai" | "anthropic" | "openai";

interface Target {
  provider: Provider;
  model: string;
}

/** The binding's typed overloads only accept known model literals; models here come from config. */
interface LooseAi {
  run(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<unknown>;
}

/** Models served with the OpenAI chat-completions schema on Workers AI. */
const OPENAI_STYLE = /^@cf\/(zai-org\/|google\/gemma-4|nvidia\/nemotron-3|openai\/gpt-oss|moonshotai\/|qwen\/qwen3\.|deepseek-ai\/deepseek-v4)/;
/** Models whose reasoning can be switched off through `chat_template_kwargs`. */
const TOGGLEABLE_THINKING = /^@cf\/(zai-org\/|qwen\/qwen3\.)/;

const EMBED_BATCH = 50;

export function modelForPurpose(config: AppConfig, purpose: Purpose): string {
  const m = config.models;
  switch (purpose) {
    case "plan":
      return m.planner;
    case "direct":
      return m.direct;
    case "research":
    case "research_queries":
    case "research_reflect":
    case "report":
      return m.research;
    case "rag":
      return m.rag;
    case "code":
      return m.code;
    case "synthesize":
    case "memory":
      return m.summarizer;
  }
}

/**
 * Every model call goes through AI Gateway (caching, retries, analytics, per-user
 * metadata). Fallback order: configured Workers AI model -> fallback Workers AI
 * model -> Anthropic (if ANTHROPIC_API_KEY) -> OpenAI (if OPENAI_API_KEY).
 */
export class GatewayLLMClient implements LLMClient {
  constructor(
    private readonly env: Env,
    private readonly ctx: LLMContext,
    private readonly log: Logger,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const config = await getConfig(this.env);
    let lastError: unknown;
    for (const target of this.chain(config, req)) {
      const started = Date.now();
      try {
        const out = await this.complete(target, req);
        const result: ChatResult = {
          text: out.text,
          provider: target.provider,
          model: target.model,
          inputTokens: out.inputTokens ?? estimateTokens(req.messages.map((m) => m.content).join("\n")),
          outputTokens: out.outputTokens ?? estimateTokens(out.text),
          cached: out.cached ?? false,
          latencyMs: Date.now() - started,
        };
        await this.record(result);
        return result;
      } catch (err) {
        lastError = err;
        this.log.warn("llm attempt failed", { ...target, purpose: req.purpose, err: errorMessage(err) });
      }
    }
    throw new AppError(502, "llm_unavailable", `All model providers failed: ${errorMessage(lastError)}`);
  }

  async stream(req: ChatRequest): Promise<ReadableStream<string>> {
    const config = await getConfig(this.env);
    let lastError: unknown;
    for (const target of this.chain(config, req)) {
      const started = Date.now();
      try {
        if (target.provider !== "workers-ai") {
          // External fallbacks are called non-streaming and replayed as one chunk.
          const result = await this.chat({ ...req, model: target.model });
          return singleChunkStream(result.text);
        }
        const body = (await this.workersAi(target.model, req, true)) as ReadableStream<Uint8Array>;
        const promptText = req.messages.map((m) => m.content).join("\n");
        return sseToTextStream(body, async (full, usage) => {
          await this.record({
            text: full,
            provider: target.provider,
            model: target.model,
            inputTokens: usage.inputTokens ?? estimateTokens(promptText),
            outputTokens: usage.outputTokens ?? estimateTokens(full),
            cached: false,
            latencyMs: Date.now() - started,
          });
        });
      } catch (err) {
        lastError = err;
        this.log.warn("llm stream attempt failed", { ...target, purpose: req.purpose, err: errorMessage(err) });
      }
    }
    throw new AppError(502, "llm_unavailable", `All model providers failed: ${errorMessage(lastError)}`);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { models } = await getConfig(this.env);
    const ai = this.env.AI as unknown as LooseAi;
    const vectors: number[][] = [];
    const started = Date.now();
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const out = (await ai.run(models.embedding, { text: batch }, {
        gateway: { ...this.gatewayOptions("embed"), cacheTtl: 86_400 },
      })) as { data?: number[][] };
      if (!out.data || out.data.length !== batch.length) throw new Error("Embedding model returned no vectors");
      vectors.push(...out.data);
    }
    await this.record({
      text: "",
      provider: "workers-ai",
      model: models.embedding,
      inputTokens: estimateTokens(texts.join("\n")),
      outputTokens: 0,
      cached: false,
      latencyMs: Date.now() - started,
    });
    return vectors;
  }

  private chain(config: AppConfig, req: ChatRequest): Target[] {
    const primary = req.model ?? modelForPurpose(config, req.purpose);
    const targets: Target[] = [{ provider: "workers-ai", model: primary }];
    if (config.models.fallback !== primary) targets.push({ provider: "workers-ai", model: config.models.fallback });
    if (secret(this.env.ANTHROPIC_API_KEY)) targets.push({ provider: "anthropic", model: config.models.anthropic });
    if (secret(this.env.OPENAI_API_KEY)) targets.push({ provider: "openai", model: config.models.openai });
    // An explicit external model (req.model) should only try its own provider.
    if (req.model && !req.model.startsWith("@")) {
      const external = targets.filter((t) => t.provider !== "workers-ai" && t.model === req.model);
      return external.length ? external : targets;
    }
    return targets;
  }

  private gatewayOptions(purpose: Purpose | "embed"): GatewayOptions {
    // AI Gateway accepts at most five metadata entries.
    return {
      id: this.env.AI_GATEWAY_ID,
      metadata: {
        userId: this.ctx.userId,
        agent: this.ctx.agent,
        purpose,
        conversationId: this.ctx.conversationId ?? "",
        traceId: this.ctx.traceId,
      },
      retries: { maxAttempts: 2, retryDelayMs: 500, backoff: "exponential" },
    };
  }

  private async complete(target: Target, req: ChatRequest): Promise<ParsedCompletion & { cached?: boolean }> {
    switch (target.provider) {
      case "workers-ai": {
        const out = parseCompletion(await this.workersAi(target.model, req, false));
        if (!out.text.trim()) throw new Error("Empty completion");
        return out;
      }
      case "anthropic":
        return this.anthropic(target.model, req);
      case "openai":
        return this.openai(target.model, req);
    }
  }

  private workersAi(model: string, req: ChatRequest, stream: boolean): Promise<unknown> {
    const input: Record<string, unknown> = {
      messages: req.messages,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.3,
    };
    if (stream) input.stream = true;
    if (OPENAI_STYLE.test(model)) {
      if (req.json) input.response_format = { type: "json_object" };
      if (stream) input.stream_options = { include_usage: true };
    }
    // Hidden reasoning burns the daily neuron budget; agents here need direct answers.
    if (TOGGLEABLE_THINKING.test(model)) input.chat_template_kwargs = { enable_thinking: false };

    const gateway = this.gatewayOptions(req.purpose);
    if (req.cacheTtl) gateway.cacheTtl = req.cacheTtl;
    return (this.env.AI as unknown as LooseAi).run(model, input, { gateway });
  }

  /** Claude through AI Gateway's Anthropic endpoint, using the official SDK. */
  private async anthropic(model: string, req: ChatRequest): Promise<ParsedCompletion> {
    const baseURL = await this.env.AI.gateway(this.env.AI_GATEWAY_ID).getUrl("anthropic");
    const client = new Anthropic({
      apiKey: secret(this.env.ANTHROPIC_API_KEY),
      baseURL,
      maxRetries: 1,
      defaultHeaders: { "cf-aig-metadata": JSON.stringify(this.gatewayOptions(req.purpose).metadata) },
    });
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages,
      output_config: { effort: "low" },
      // Server-side refusal fallback: a declined request is retried on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") throw new Error("Anthropic declined the request");
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  /** OpenAI through the AI Gateway universal endpoint. */
  private async openai(model: string, req: ChatRequest): Promise<ParsedCompletion & { cached: boolean }> {
    const gateway = this.env.AI.gateway(this.env.AI_GATEWAY_ID);
    const res = await gateway.run({
      provider: "openai",
      endpoint: "chat/completions",
      headers: {
        Authorization: `Bearer ${secret(this.env.OPENAI_API_KEY)}`,
        "Content-Type": "application/json",
        "cf-aig-metadata": JSON.stringify(this.gatewayOptions(req.purpose).metadata),
      },
      query: {
        model,
        messages: req.messages,
        max_completion_tokens: Math.max(req.maxTokens ?? 1024, 4096),
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      },
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const out = parseCompletion(await res.json());
    if (!out.text.trim()) throw new Error("Empty completion");
    return { ...out, cached: res.headers.get("cf-aig-cache-status") === "HIT" };
  }

  private async record(result: ChatResult): Promise<void> {
    try {
      await recordUsage(this.env.DB, {
        userId: this.ctx.userId,
        conversationId: this.ctx.conversationId,
        agent: this.ctx.agent,
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cached: result.cached,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      this.log.warn("usage record failed", { err: errorMessage(err) });
    }
  }
}
