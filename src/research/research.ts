import type { Source } from "../lib/types";
import type { LLMClient } from "../llm";
import { researchMessages } from "../llm/prompts";
import { webSearch } from "./search";

export interface ResearchFindings {
  findings: string;
  sources: Source[];
}

/** One research step: search the web, then have the model write cited findings. Shared by ResearchAgent and DeepResearchWorkflow. */
export async function researchQuery(
  env: Env,
  llm: LLMClient,
  input: { query: string; question: string },
): Promise<ResearchFindings> {
  const sources = await webSearch(env, input.query);
  if (sources.length === 0) {
    return { findings: `No search results found for "${input.query}".`, sources: [] };
  }
  const result = await llm.chat({
    purpose: "research",
    messages: researchMessages({ instruction: input.query, question: input.question, sources }),
    maxTokens: 800,
    temperature: 0.2,
  });
  return { findings: result.text, sources };
}
