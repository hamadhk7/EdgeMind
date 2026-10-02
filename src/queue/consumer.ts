import { getAgentByName } from "agents";
import type { OrchestratorAgent } from "../agents/orchestrator";
import type { SpecialistAgent } from "../agents/specialist";
import { errorMessage } from "../lib/errors";
import { createLogger } from "../lib/logger";
import type { QueueMessage, SpecialistKind, SubtaskResult } from "../lib/types";

export const DLQ_SUFFIX = "-dlq";
const MAX_RETRY_DELAY_SECONDS = 60;

function specialistNamespace(env: Env, kind: SpecialistKind): DurableObjectNamespace<SpecialistAgent> {
  const namespaces: Record<SpecialistKind, DurableObjectNamespace> = {
    research: env.ResearchAgent,
    rag: env.RagAgent,
    code: env.CodeAgent,
  };
  return namespaces[kind] as unknown as DurableObjectNamespace<SpecialistAgent>;
}

function orchestrator(env: Env, name: string) {
  return getAgentByName(env.OrchestratorAgent as unknown as DurableObjectNamespace<OrchestratorAgent>, name);
}

/**
 * Consumes subtasks: notify the orchestrator, run the specialist (one Durable
 * Object per user and agent type), and hand the result back. Failures are
 * retried with exponential backoff; after `max_retries` the message moves to
 * the dead-letter queue, whose consumer reports the subtask as failed.
 */
export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  const deadLetter = batch.queue.endsWith(DLQ_SUFFIX);
  await Promise.all(batch.messages.map((msg) => (deadLetter ? handleDeadLetter(msg, env) : handleTask(msg, env))));
}

async function handleTask(msg: Message<QueueMessage>, env: Env): Promise<void> {
  const { envelope } = msg.body;
  const log = createLogger({
    component: "queue",
    traceId: envelope.traceId,
    runId: envelope.runId,
    taskId: envelope.taskId,
    agent: envelope.agent,
    attempt: msg.attempts,
  });
  try {
    const orch = await orchestrator(env, envelope.orchestrator);
    const stillWanted = await orch.markSubtaskRunning(envelope.runId, envelope.taskId, msg.attempts);
    if (!stillWanted) {
      log.info("subtask no longer needed, skipping");
      msg.ack();
      return;
    }
    const specialist = await getAgentByName(specialistNamespace(env, envelope.agent), envelope.userId);
    const result = await specialist.runTask(envelope);
    await orch.onSubtaskResult(result);
    msg.ack();
  } catch (err) {
    const delaySeconds = Math.min(MAX_RETRY_DELAY_SECONDS, 2 ** msg.attempts * 2);
    log.warn("subtask attempt failed, retrying", { err: errorMessage(err), delaySeconds });
    msg.retry({ delaySeconds });
  }
}

async function handleDeadLetter(msg: Message<QueueMessage>, env: Env): Promise<void> {
  const { envelope } = msg.body;
  const log = createLogger({ component: "dlq", traceId: envelope.traceId, runId: envelope.runId, taskId: envelope.taskId });
  const result: SubtaskResult = {
    taskId: envelope.taskId,
    runId: envelope.runId,
    agent: envelope.agent,
    status: "failed",
    output: "",
    sources: [],
    error: "The agent failed after several retries",
    durationMs: 0,
  };
  try {
    const orch = await orchestrator(env, envelope.orchestrator);
    await orch.onSubtaskResult(result);
    log.warn("subtask dead-lettered");
    msg.ack();
  } catch (err) {
    log.error("dead-letter handling failed", { err: errorMessage(err) });
    msg.retry({ delaySeconds: 10 });
  }
}
