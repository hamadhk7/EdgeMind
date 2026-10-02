import { Agent } from "agents";
import { errorMessage } from "../lib/errors";
import { createLogger, type Logger } from "../lib/logger";
import type { Source, SpecialistKind, SubtaskEnvelope, SubtaskResult } from "../lib/types";
import { createLLM, type LLMClient } from "../llm";

export interface ExecuteOutput {
  output: string;
  sources: Source[];
}

interface TaskLogRow {
  task_id: string;
  status: "running" | "completed" | "error";
  result_json: string | null;
  attempts: number;
}

/**
 * Base class for queue-driven specialist agents. One instance per user, so each
 * specialist keeps its own task history. `runTask` is idempotent by task id:
 * Queues deliver at-least-once, and a redelivered task returns the stored result
 * instead of spending tokens again.
 */
export abstract class SpecialistAgent extends Agent<Env> {
  protected abstract readonly kind: SpecialistKind;
  protected abstract execute(task: SubtaskEnvelope, llm: LLMClient, log: Logger): Promise<ExecuteOutput>;

  private tablesReady = false;

  private ensureTables(): void {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS task_log (
      task_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.tablesReady = true;
  }

  async runTask(task: SubtaskEnvelope): Promise<SubtaskResult> {
    this.ensureTables();
    const log = createLogger({ agent: this.kind, traceId: task.traceId, runId: task.runId, taskId: task.taskId });

    const [existing] = this.sql<TaskLogRow>`
      SELECT task_id, status, result_json, attempts FROM task_log WHERE task_id = ${task.taskId}`;
    if (existing?.status === "completed" && existing.result_json) {
      log.info("duplicate delivery, returning stored result");
      return JSON.parse(existing.result_json) as SubtaskResult;
    }

    const started = Date.now();
    this.sql`INSERT INTO task_log (task_id, run_id, status, input, attempts, created_at, updated_at)
      VALUES (${task.taskId}, ${task.runId}, 'running', ${task.input}, 1, ${started}, ${started})
      ON CONFLICT(task_id) DO UPDATE SET status = 'running', attempts = attempts + 1, updated_at = ${started}`;

    const llm = createLLM(this.env, {
      userId: task.userId,
      agent: this.kind,
      traceId: task.traceId,
      conversationId: task.conversationId,
      runId: task.runId,
    });

    try {
      const { output, sources } = await this.execute(task, llm, log);
      const result: SubtaskResult = {
        taskId: task.taskId,
        runId: task.runId,
        agent: this.kind,
        status: "completed",
        output,
        sources,
        durationMs: Date.now() - started,
      };
      this.sql`UPDATE task_log SET status = 'completed', result_json = ${JSON.stringify(result)},
        updated_at = ${Date.now()} WHERE task_id = ${task.taskId}`;
      log.info("task completed", { durationMs: result.durationMs });
      return result;
    } catch (err) {
      // Rethrow so the queue consumer retries; after max retries the DLQ marks it failed.
      this.sql`UPDATE task_log SET status = 'error', error = ${errorMessage(err)}, updated_at = ${Date.now()}
        WHERE task_id = ${task.taskId}`;
      log.warn("task attempt failed", { err: errorMessage(err) });
      throw err;
    }
  }

  /** Recent task history for this user's specialist (debugging / observability). */
  async recentTasks(limit = 20): Promise<Array<{ task_id: string; status: string; attempts: number }>> {
    this.ensureTables();
    return this.sql<{ task_id: string; status: string; attempts: number }>`
      SELECT task_id, status, attempts FROM task_log ORDER BY created_at DESC LIMIT ${limit}`;
  }

  /** Specialists are internal: never reachable over HTTP/WebSocket. */
  override onRequest(): Response {
    return new Response("Not found", { status: 404 });
  }
}

export function upstreamContext(task: SubtaskEnvelope): string {
  return task.context.map((c) => `[${c.agent} result]\n${c.output}`).join("\n\n");
}
