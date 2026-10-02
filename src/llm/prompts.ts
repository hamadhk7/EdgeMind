import type { ChatMessage } from "./types";
import type { Source } from "../lib/types";

/** Shared formatting for numbered sources so agents and the synthesizer cite consistently. */
export function formatSources(sources: Source[]): string {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title}${s.url ? ` (${s.url})` : ""}${s.snippet ? `\n${s.snippet}` : ""}`)
    .join("\n\n");
}

export function plannerMessages(input: {
  request: string;
  history: string;
  memories: string[];
  docCount: number;
  maxSubtasks: number;
}): ChatMessage[] {
  const system = `You are the planner of EdgeMind, a team of AI agents. Decide how to handle the user's latest request.

Available agents:
- research: searches the web. "input" must be a short search query (at most 8 words).
- rag: searches the user's uploaded documents and answers from them. "input" is a question about those documents.
- code: writes, explains or reviews code. "input" is a precise coding instruction.

Modes:
- "direct": greetings, small talk, follow-ups answerable from the conversation, or simple general-knowledge questions.
- "delegate": anything that needs a lookup, the user's documents, or code. Plan 1-${input.maxSubtasks} subtasks. Set "dependsOn" only when a subtask needs another subtask's output.
- "deep_research": only when the user explicitly asks for in-depth research or a report.

Rules:
- Uploaded documents: ${input.docCount}. If this is 0, never plan a rag subtask.
- Subtask ids are short, like "t1", "t2".
- Reply with a single JSON object and nothing else:
{"mode":"direct|delegate|deep_research","rationale":"one sentence","subtasks":[{"id":"t1","agent":"research","input":"...","dependsOn":[]}]}`;

  const memoryBlock = input.memories.length
    ? `Known facts about the user:\n${input.memories.map((m) => `- ${m}`).join("\n")}\n\n`
    : "";
  const historyBlock = input.history ? `Recent conversation:\n${input.history}\n\n` : "";
  return [
    { role: "system", content: system },
    { role: "user", content: `${memoryBlock}${historyBlock}REQUEST:\n${input.request}` },
  ];
}

export const PLAN_REPAIR =
  "Your previous reply was not valid JSON matching the required shape. Reply again with only the JSON object.";

export function directMessages(input: { request: string; history: string; memories: string[] }): ChatMessage[] {
  const memoryBlock = input.memories.length
    ? `\nKnown facts about the user:\n${input.memories.map((m) => `- ${m}`).join("\n")}`
    : "";
  return [
    {
      role: "system",
      content: `You are EdgeMind, a concise and friendly assistant. Answer in Markdown. Keep answers short unless asked for detail.${memoryBlock}`,
    },
    ...(input.history ? [{ role: "user" as const, content: `Conversation so far:\n${input.history}` }] : []),
    { role: "user", content: input.request },
  ];
}

export function researchMessages(input: { instruction: string; question: string; sources: Source[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a research agent. Using only the numbered sources, write concise findings (5-8 bullet points) relevant to the question. Cite sources inline as [n]. If the sources do not cover something, say so.",
    },
    {
      role: "user",
      content: `Question: ${input.question}\nSearch focus: ${input.instruction}\n\nSources:\n${formatSources(input.sources) || "(no results)"}`,
    },
  ];
}

export function ragMessages(input: { instruction: string; passages: Source[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You answer questions from the user's own documents. Use only the numbered passages. Cite them inline as [n]. If the passages do not contain the answer, say that clearly.",
    },
    { role: "user", content: `Question: ${input.instruction}\n\nPassages:\n${formatSources(input.passages)}` },
  ];
}

export function codeMessages(input: { instruction: string; question: string; context: string }): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a senior software engineer. Produce correct, idiomatic, well-structured code in fenced Markdown blocks with a short explanation. Prefer TypeScript unless another language is requested.",
    },
    {
      role: "user",
      content: `${input.context ? `Context from other agents:\n${input.context}\n\n` : ""}User request: ${input.question}\n\nTask: ${input.instruction}`,
    },
  ];
}

export function synthesisMessages(input: {
  question: string;
  history: string;
  memories: string[];
  results: Array<{ agent: string; status: string; output: string }>;
  sources: Source[];
}): ChatMessage[] {
  const results = input.results
    .map((r, i) => `### Agent ${i + 1}: ${r.agent} (${r.status})\n${r.output || "(no output)"}`)
    .join("\n\n");
  const memoryBlock = input.memories.length
    ? `Known facts about the user:\n${input.memories.map((m) => `- ${m}`).join("\n")}\n\n`
    : "";
  return [
    {
      role: "system",
      content: `You are the synthesizer of EdgeMind. Combine the specialist agents' results into one clear answer in Markdown.
- Answer the user's question directly first, then supporting detail.
- Keep citation markers like [1] that refer to the numbered source list; do not invent sources.
- If an agent failed or timed out, briefly note what is missing instead of guessing.
- Do not mention the agents or this process unless it helps the user.`,
    },
    {
      role: "user",
      content: `${memoryBlock}${input.history ? `Recent conversation:\n${input.history}\n\n` : ""}Question: ${input.question}\n\nAgent results:\n${results}\n\nSources:\n${formatSources(input.sources) || "(none)"}`,
    },
  ];
}

export function memoryMessages(input: { question: string; answer: string; existing: string[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content: `Extract at most 3 durable facts about the user worth remembering in future conversations (name, preferences, projects, goals). Ignore one-off questions and general knowledge. Skip facts already known.
Reply with JSON only: {"facts":["..."]}. Use an empty list when there is nothing durable.`,
    },
    {
      role: "user",
      content: `Already known:\n${input.existing.map((f) => `- ${f}`).join("\n") || "(none)"}\n\nUser said: ${input.question}\n\nAssistant answered: ${input.answer.slice(0, 2000)}`,
    },
  ];
}

export function researchQueriesMessages(input: { question: string; notes: string; round: number }): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        'You plan web searches for an in-depth research task. Propose up to 3 new short search queries (max 8 words each) that fill gaps in the notes so far. Reply with JSON only: {"queries":["..."]}',
    },
    {
      role: "user",
      content: `Research question: ${input.question}\nRound: ${input.round}\n\nNotes so far:\n${input.notes || "(none yet)"}`,
    },
  ];
}

export function researchReflectMessages(input: { question: string; notes: string }): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        'You review research notes. Decide whether they are sufficient to write a thorough report. Reply with JSON only: {"done":true|false,"gaps":["..."]}',
    },
    { role: "user", content: `Research question: ${input.question}\n\nNotes:\n${input.notes}` },
  ];
}

export function reportMessages(input: { question: string; notes: string; sources: Source[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Write a well-structured research report in Markdown: title, executive summary, key findings with headings, open questions, and a numbered Sources section. Cite sources inline as [n] using the numbered list provided. Be factual and specific.",
    },
    {
      role: "user",
      content: `Research question: ${input.question}\n\nNotes:\n${input.notes}\n\nSources:\n${formatSources(input.sources)}`,
    },
  ];
}
