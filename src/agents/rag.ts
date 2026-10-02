import type { Logger } from "../lib/logger";
import type { Source, SubtaskEnvelope } from "../lib/types";
import type { LLMClient } from "../llm";
import { ragMessages } from "../llm/prompts";
import { createVectorStore } from "../memory/vectorStore";
import { type ExecuteOutput, SpecialistAgent } from "./specialist";

const TOP_K = 6;
const MIN_SCORE = 0.35;

/** Retrieval-augmented answers over the user's uploaded documents. */
export class RagAgent extends SpecialistAgent {
  protected readonly kind = "rag" as const;

  protected async execute(task: SubtaskEnvelope, llm: LLMClient, log: Logger): Promise<ExecuteOutput> {
    const [vector] = await llm.embed([task.input]);
    if (!vector) throw new Error("Embedding failed");

    const matches = (await createVectorStore(this.env).query(task.userId, vector, { topK: TOP_K, kind: "doc" })).filter(
      (m) => m.score >= MIN_SCORE,
    );
    if (matches.length === 0) {
      return { output: "No relevant passages were found in the user's documents.", sources: [] };
    }

    const passages = await this.loadPassages(task.userId, matches.map((m) => m.id));
    log.info("retrieved passages", { matches: matches.length, passages: passages.length });
    if (passages.length === 0) {
      return { output: "No relevant passages were found in the user's documents.", sources: [] };
    }

    const result = await llm.chat({
      purpose: "rag",
      messages: ragMessages({ instruction: task.input, passages }),
      maxTokens: 800,
      temperature: 0.1,
    });
    return { output: result.text, sources: passages.map(({ snippet: _snippet, ...source }) => source) };
  }

  /** Chunk text lives in D1; Vectorize returns only ids and scores. Order follows relevance. */
  private async loadPassages(userId: string, ids: string[]): Promise<Source[]> {
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await this.env.DB.prepare(
      `SELECT c.id, c.text, c.document_id, d.filename
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.user_id = ? AND c.id IN (${placeholders})`,
    )
      .bind(userId, ...ids)
      .all<{ id: string; text: string; document_id: string; filename: string }>();
    const byId = new Map(results.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r) => r !== undefined)
      .map((r) => ({ title: r.filename, documentId: r.document_id, snippet: r.text }));
  }
}
