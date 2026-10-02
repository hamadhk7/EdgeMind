import type { Logger } from "../lib/logger";
import type { SubtaskEnvelope } from "../lib/types";
import type { LLMClient } from "../llm";
import { researchQuery } from "../research/research";
import { type ExecuteOutput, SpecialistAgent } from "./specialist";

/** Looks things up on the web and returns cited findings. */
export class ResearchAgent extends SpecialistAgent {
  protected readonly kind = "research" as const;

  protected async execute(task: SubtaskEnvelope, llm: LLMClient, log: Logger): Promise<ExecuteOutput> {
    const { findings, sources } = await researchQuery(this.env, llm, { query: task.input, question: task.question });
    log.info("research done", { sources: sources.length });
    return { output: findings, sources };
  }
}
