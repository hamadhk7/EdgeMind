import { errorMessage } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { SubtaskEnvelope } from "../lib/types";
import type { LLMClient } from "../llm";
import { ragMessages } from "../llm/prompts";
import { retrieveChunks } from "../memory/retrieval";
import { type ExecuteOutput, SpecialistAgent } from "./specialist";

const TOP_K = 6;
const NOTHING_FOUND = "No relevant passages were found in the user's documents.";

/** Retrieval-augmented answers over the user's uploaded documents (hybrid keyword + vector search). */
export class RagAgent extends SpecialistAgent {
  protected readonly kind = "rag" as const;

  protected async execute(task: SubtaskEnvelope, llm: LLMClient, log: Logger): Promise<ExecuteOutput> {
    // Search with both the planner's instruction and the user's own words.
    const question = `${task.input}\n${task.question}`;
    const vector = await llm
      .embed([task.input])
      .then(([v]) => v)
      .catch((err) => {
        // Keyword search still works if embeddings are unavailable.
        log.warn("embedding failed, keyword search only", { err: errorMessage(err) });
        return undefined;
      });

    const { chunks, keywordHits, vectorScores } = await retrieveChunks(this.env, {
      userId: task.userId,
      question,
      vector,
      topK: TOP_K,
    });
    log.info("retrieval", {
      keywordHits,
      vectorScores: vectorScores.map((s) => Number(s.toFixed(3))),
      returned: chunks.length,
    });
    if (chunks.length === 0) return { output: NOTHING_FOUND, sources: [] };

    const passages = chunks.map((c) => ({ title: c.filename, documentId: c.documentId, snippet: c.text }));
    const result = await llm.chat({
      purpose: "rag",
      messages: ragMessages({ instruction: task.input, passages }),
      maxTokens: 800,
      temperature: 0.1,
    });
    return { output: result.text, sources: passages.map(({ snippet: _snippet, ...source }) => source) };
  }
}
