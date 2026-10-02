/**
 * Workers AI returns two output shapes: OpenAI-style chat completions for newer
 * models (`choices[0].message.content`) and the legacy `{ response }` shape for
 * older ones. These helpers normalize both, including their streaming forms.
 */

export interface ParsedCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface CompletionLike {
  response?: unknown;
  choices?: Array<{ message?: { content?: string | null }; delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parseCompletion(out: unknown): ParsedCompletion {
  if (typeof out === "string") return { text: out };
  const o = (out ?? {}) as CompletionLike;
  const fromChoices = o.choices?.[0]?.message?.content;
  let text = "";
  if (typeof fromChoices === "string") text = fromChoices;
  else if (typeof o.response === "string") text = o.response;
  else if (o.response != null) text = JSON.stringify(o.response);
  return {
    text,
    inputTokens: o.usage?.prompt_tokens,
    outputTokens: o.usage?.completion_tokens,
  };
}

/** Extracts the text delta and any usage block from one SSE `data:` payload. */
export function parseStreamChunk(payload: string): ParsedCompletion | null {
  if (payload === "[DONE]") return null;
  try {
    const o = JSON.parse(payload) as CompletionLike;
    const delta = o.choices?.[0]?.delta?.content;
    return {
      text: typeof delta === "string" ? delta : typeof o.response === "string" ? o.response : "",
      inputTokens: o.usage?.prompt_tokens,
      outputTokens: o.usage?.completion_tokens,
    };
  } catch {
    return null;
  }
}

/**
 * Converts a Workers AI server-sent-event byte stream into a stream of text
 * deltas. `onDone` receives the full text and any usage the provider reported.
 */
export function sseToTextStream(
  body: ReadableStream<Uint8Array>,
  onDone: (full: string, usage: { inputTokens?: number; outputTokens?: number }) => Promise<void>,
): ReadableStream<string> {
  let buffer = "";
  let full = "";
  const usage: { inputTokens?: number; outputTokens?: number } = {};

  const handleLine = (line: string, controller: TransformStreamDefaultController<string>) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const chunk = parseStreamChunk(trimmed.slice(5).trim());
    if (!chunk) return;
    if (chunk.inputTokens !== undefined) usage.inputTokens = chunk.inputTokens;
    if (chunk.outputTokens !== undefined) usage.outputTokens = chunk.outputTokens;
    if (chunk.text) {
      full += chunk.text;
      controller.enqueue(chunk.text);
    }
  };

  return body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream<string, string>({
      transform(text, controller) {
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line, controller);
      },
      async flush(controller) {
        if (buffer) handleLine(buffer, controller);
        await onDone(full, usage);
      },
    }),
  );
}

/** A stream that emits one chunk; used when a fallback provider is non-streaming. */
export function singleChunkStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      if (text) controller.enqueue(text);
      controller.close();
    },
  });
}

/**
 * Pulls the first JSON object out of model output, tolerating markdown fences
 * and prose around it. Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
