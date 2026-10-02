import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { OrchestratorAgent } from "../agents/orchestrator";
import { renumberCitations } from "../agents/citations";
import { getConfig } from "../lib/config";
import type { Source } from "../lib/types";
import { createLLM, extractJson, type LLMClient } from "../llm";
import { reportMessages, researchQueriesMessages, researchReflectMessages } from "../llm/prompts";
import { researchQuery } from "../research/research";

export interface DeepResearchParams {
  runId: string;
  userId: string;
  conversationId: string;
  question: string;
  traceId: string;
}

export interface DeepResearchProgress {
  runId: string;
  step: string;
  message: string;
  percent?: number;
  [key: string]: unknown;
}

export interface DeepResearchResult {
  runId: string;
  report: string;
  reportKey: string;
  sources: Source[];
}

interface Note {
  query: string;
  findings: string;
  sources: Source[];
}

const MAX_QUERIES_PER_ROUND = 3;
const RESEARCH_STEP = {
  retries: { limit: 2, delay: "3 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/**
 * Multi-round research as a durable Workflow: each search and model call is a
 * step, so a crash or deploy resumes where it stopped instead of starting over.
 * Progress streams to the originating OrchestratorAgent, which relays it to clients.
 */
export class DeepResearchWorkflow extends AgentWorkflow<OrchestratorAgent, DeepResearchParams, DeepResearchProgress> {
  override async run(event: AgentWorkflowEvent<DeepResearchParams>, step: AgentWorkflowStep): Promise<DeepResearchResult> {
    const { runId, userId, conversationId, question, traceId } = event.payload;
    const llm = createLLM(this.env, { userId, conversationId, traceId, runId, agent: "research" });
    const { limits } = await getConfig(this.env);
    const rounds = limits.deepResearchRounds;
    const notes: Note[] = [];

    for (let round = 1; round <= rounds; round++) {
      await this.reportProgress({
        runId,
        step: "plan",
        message: `Round ${round}: choosing what to search`,
        percent: (round - 1) / (rounds + 1),
      });
      const queries = await step.do(`queries-${round}`, RESEARCH_STEP, () =>
        planQueries(llm, question, notesText(notes), round),
      );

      for (const [i, query] of queries.entries()) {
        await this.reportProgress({
          runId,
          step: "search",
          message: `Round ${round}: researching "${query}"`,
          percent: (round - 1 + (i + 1) / (queries.length + 1)) / (rounds + 1),
        });
        const note = await step.do(`research-${round}-${i}`, RESEARCH_STEP, async () => {
          const { findings, sources } = await researchQuery(this.env, llm, { query, question });
          return { query, findings, sources };
        });
        notes.push(note);
      }

      if (round === rounds) break;
      const done = await step.do(`reflect-${round}`, RESEARCH_STEP, () => reflect(llm, question, notesText(notes)));
      if (done) break;
    }

    await this.reportProgress({ runId, step: "report", message: "Writing the report", percent: rounds / (rounds + 1) });
    const { report, reportKey, sources } = await step.do("write-report", RESEARCH_STEP, async () => {
      const merged = mergeNotes(notes);
      const result = await llm.chat({
        purpose: "report",
        messages: reportMessages({ question, notes: merged.text, sources: merged.sources }),
        maxTokens: 2500,
        temperature: 0.3,
      });
      const key = `reports/${userId}/${runId}.md`;
      await this.env.FILES.put(key, result.text, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        customMetadata: { userId, conversationId, runId },
      });
      return { report: result.text, reportKey: key, sources: merged.sources };
    });

    const output: DeepResearchResult = { runId, report, reportKey, sources };
    await step.reportComplete(output);
    return output;
  }
}

async function planQueries(llm: LLMClient, question: string, notes: string, round: number): Promise<string[]> {
  const result = await llm.chat({
    purpose: "research_queries",
    messages: researchQueriesMessages({ question, notes, round }),
    json: true,
    maxTokens: 200,
    temperature: 0.4,
  });
  const raw = (extractJson(result.text) as { queries?: unknown } | undefined)?.queries;
  const queries = (Array.isArray(raw) ? raw : [])
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .map((q) => q.trim().slice(0, 120))
    .slice(0, MAX_QUERIES_PER_ROUND);
  return queries.length ? queries : [question.slice(0, 120)];
}

async function reflect(llm: LLMClient, question: string, notes: string): Promise<boolean> {
  const result = await llm.chat({
    purpose: "research_reflect",
    messages: researchReflectMessages({ question, notes }),
    json: true,
    maxTokens: 200,
    temperature: 0,
  });
  return (extractJson(result.text) as { done?: unknown } | undefined)?.done === true;
}

function notesText(notes: Note[]): string {
  return notes.map((n) => `## ${n.query}\n${n.findings}`).join("\n\n").slice(0, 12_000);
}

/** One numbered source list across all notes, with each note's citations renumbered to match. */
function mergeNotes(notes: Note[]): { text: string; sources: Source[] } {
  const sources: Source[] = [];
  const sections = notes.map((n) => {
    const findings = renumberCitations(n.findings, n.sources.length, sources.length);
    sources.push(...n.sources);
    return `## ${n.query}\n${findings}`;
  });
  return { text: sections.join("\n\n").slice(0, 24_000), sources };
}
