import { describe, expect, it } from "vitest";
import { mergeResults, renumberCitations } from "../../src/agents/citations";
import { signJwt, verifyJwt } from "../../src/auth/jwt";
import { generateApiKey, isApiKey, sha256Hex } from "../../src/auth/apiKeys";
import { parseOrchestratorName } from "../../src/auth/principal";
import { estimateCost } from "../../src/lib/usage";
import { hashEmbedding } from "../../src/llm/fake";
import { extractJson, parseCompletion, sseToTextStream } from "../../src/llm/parse";
import { chunkText } from "../../src/memory/chunker";
import { ftsQuery } from "../../src/memory/retrieval";
import { cosine } from "../../src/memory/vectorStore";

describe("chunkText", () => {
  it("keeps short text as one chunk", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text under the size limit with overlap", () => {
    const paragraph = "Edge computing moves work closer to users. ".repeat(20);
    const text = Array.from({ length: 10 }, () => paragraph).join("\n\n");
    const chunks = chunkText(text, { maxChars: 1000, overlap: 200 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    // Overlap: the start of each chunk repeats text from the end of the previous one.
    expect(chunks[0]!.endsWith(chunks[1]!.split("\n\n")[0]!.slice(-50))).toBe(true);
  });

  it("hard-splits a single enormous word", () => {
    const chunks = chunkText("x".repeat(2500), { maxChars: 1000, overlap: 0 });
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
  });
});

describe("JWT", () => {
  it("round-trips claims", async () => {
    const token = await signJwt({ sub: "usr_1", kind: "guest" }, "secret", 60);
    expect(await verifyJwt(token, "secret")).toMatchObject({ sub: "usr_1", kind: "guest" });
  });

  it("rejects a wrong secret, tampering and expiry", async () => {
    const token = await signJwt({ sub: "usr_1", kind: "guest" }, "secret", 60);
    expect(await verifyJwt(token, "other")).toBeNull();
    const [h, , s] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "usr_admin", kind: "key", iat: 0, exp: 9999999999 })).replace(/=+$/, "");
    expect(await verifyJwt(`${h}.${forged}.${s}`, "secret")).toBeNull();
    const expired = await signJwt({ sub: "usr_1", kind: "guest" }, "secret", -1);
    expect(await verifyJwt(expired, "secret")).toBeNull();
    expect(await verifyJwt("not-a-token", "secret")).toBeNull();
  });
});

describe("API keys", () => {
  it("generates prefixed, unique keys and stable hashes", async () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(isApiKey(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(await sha256Hex(a)).toBe(await sha256Hex(a));
    expect(await sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseOrchestratorName", () => {
  it("splits user and conversation ids", () => {
    expect(parseOrchestratorName("usr_abc__cnv_def")).toEqual({ userId: "usr_abc", conversationId: "cnv_def" });
    expect(parseOrchestratorName("usr_abc")).toBeNull();
    expect(parseOrchestratorName("a__b__c")).toBeNull();
  });
});

describe("model output parsing", () => {
  it("reads OpenAI-style and legacy completions", () => {
    expect(parseCompletion({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })).toEqual({
      text: "hi",
      inputTokens: 3,
      outputTokens: 1,
    });
    expect(parseCompletion({ response: "legacy" }).text).toBe("legacy");
    expect(parseCompletion({ response: { mode: "direct" } }).text).toBe('{"mode":"direct"}');
  });

  it("extracts JSON from fenced or chatty output", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Plan: {"mode":"direct"} done')).toEqual({ mode: "direct" });
    expect(extractJson("no json here")).toBeUndefined();
  });

  it("turns an SSE byte stream into text deltas and reports usage", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"response":"!"}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of sse) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    let done: { full: string; usage: object } | undefined;
    const stream = sseToTextStream(body, async (full, usage) => {
      done = { full, usage };
    });
    const parts: string[] = [];
    for await (const chunk of stream) parts.push(chunk);
    expect(parts.join("")).toBe("Hello!");
    expect(done).toEqual({ full: "Hello!", usage: { inputTokens: 5, outputTokens: 2 } });
  });
});

describe("citations", () => {
  it("renumbers only citations within the agent's own source range", () => {
    expect(renumberCitations("A [1] B [2] C [5]", 2, 3)).toBe("A [4] B [5] C [5]");
    expect(renumberCitations("A [1]", 1, 0)).toBe("A [1]");
  });

  it("merges sources across agents", () => {
    const { results, sources } = mergeResults([
      { agent: "research", status: "completed", output: "X [1] Y [2]", error: null, sources: [{ title: "a" }, { title: "b" }] },
      { agent: "rag", status: "failed", output: null, error: "boom", sources: [{ title: "ignored" }] },
      { agent: "research", status: "completed", output: "Z [1]", error: null, sources: [{ title: "c" }] },
    ]);
    expect(sources.map((s) => s.title)).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.output)).toEqual(["X [1] Y [2]", "(failed: boom)", "Z [3]"]);
  });
});

describe("misc", () => {
  it("estimates cost from the price table", () => {
    expect(estimateCost("@cf/zai-org/glm-4.7-flash", 1_000_000, 1_000_000)).toBeCloseTo(0.46);
    expect(estimateCost("unknown-model", 1000, 1000)).toBe(0);
  });

  it("offline embeddings make related texts closer than unrelated ones", () => {
    const a = hashEmbedding("cloudflare workers durable objects");
    const b = hashEmbedding("durable objects on cloudflare");
    const c = hashEmbedding("banana bread recipe");
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(a).toHaveLength(768);
  });
});

describe("ftsQuery", () => {
  it("keeps significant terms, drops stopwords, quotes each term", () => {
    expect(ftsQuery("According to my uploaded documents, what is the Falcon-7 launch date?")).toBe(
      '"falcon-7" OR "launch" OR "date"',
    );
    expect(ftsQuery("what is it?")).toBeNull();
    expect(ftsQuery('evil" OR 1=1 --')).toBe('"evil"');
  });
});
