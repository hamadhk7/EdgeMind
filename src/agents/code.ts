import type { Logger } from "../lib/logger";
import type { SubtaskEnvelope } from "../lib/types";
import type { LLMClient } from "../llm";
import { codeMessages } from "../llm/prompts";
import { type ExecuteOutput, SpecialistAgent, upstreamContext } from "./specialist";

/** Writes, explains and reviews code. It does not execute anything. */
export class CodeAgent extends SpecialistAgent {
  protected readonly kind = "code" as const;

  protected async execute(task: SubtaskEnvelope, llm: LLMClient, _log: Logger): Promise<ExecuteOutput> {
    const result = await llm.chat({
      purpose: "code",
      messages: codeMessages({ instruction: task.input, question: task.question, context: upstreamContext(task) }),
      maxTokens: 1500,
      temperature: 0.2,
    });
    return { output: result.text, sources: [] };
  }
}
