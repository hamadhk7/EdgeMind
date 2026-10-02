import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { z } from "zod";
import { parseOrchestratorName } from "../auth/principal";
import { audit } from "../lib/audit";
import { getConfig } from "../lib/config";
import { AppError, errorMessage } from "../lib/errors";
import { newId } from "../lib/ids";
import { createLogger, type Logger } from "../lib/logger";
import {
  type ChatMessageView,
  type Plan,
  type QueueMessage,
  type RunMode,
  type RunStatus,
  type ServerEvent,
  type Source,
  type SpecialistKind,
  type SubtaskEnvelope,
  type SubtaskResult,
  type SubtaskStatus,
  TERMINAL_STATUSES,
  type UserKind,
} from "../lib/types";
import { assertWithinBudget } from "../lib/usage";
import { createLLM, type LLMClient } from "../llm";
import { directMessages } from "../llm/prompts";
import { createVectorStore } from "../memory/vectorStore";
import type { DeepResearchParams, DeepResearchProgress, DeepResearchResult } from "../workflows/deepResearch";
import { mergeResults } from "./citations";
import { allSettled, planRequest, readySubtasks } from "./planner";
import type { SummarizerAgent } from "./summarizer";

interface OrchestratorState {
  activeRunId: string | null;
}

interface RunRow {
  id: string;
  status: RunStatus;
  mode: RunMode | null;
  client_mode: "auto" | "deep";
  request: string;
  trace_id: string;
  rationale: string | null;
  memories_json: string;
  workflow_id: string | null;
  error: string | null;
  created_at: number;
}

interface SubtaskRow {
  id: string;
  run_id: string;
  agent: SpecialistKind;
  input: string;
  depends_on: string;
  status: SubtaskStatus;
  output: string | null;
  sources_json: string | null;
  error: string | null;
  created_at: number;
}

interface Subtask {
  id: string;
  agent: SpecialistKind;
  input: string;
  dependsOn: string[];
  status: SubtaskStatus;
  output: string | null;
  error: string | null;
  sources: Source[];
}

const ClientMessageSchema = z.object({
  type: z.literal("chat"),
  text: z.string().trim().min(1).max(4000),
  mode: z.enum(["auto", "deep"]).default("auto"),
});

const ACTIVE: ReadonlySet<RunStatus> = new Set(["planning", "running", "synthesizing"]);
const HISTORY_MESSAGES = 8;
const CONTEXT_CHARS = 8000;
const EVENT_OUTPUT_CHARS = 4000;
const MEMORY_MIN_SCORE = 0.5;
const PLANNING_GRACE_SECONDS = 30;
const DEEP_RESEARCH_TIMEOUT_SECONDS = 900;

/**
 * One instance per conversation (`<userId>__<conversationId>`). Owns the
 * conversation history and the lifecycle of each run:
 *
 *   chat message -> plan (LLM) -> direct answer
 *                              -> subtasks over Cloudflare Queues -> specialists -> results
 *                              -> DeepResearchWorkflow
 *               -> synthesis (SummarizerAgent, streamed) -> final answer -> memory distillation
 *
 * Long steps run through the Agents SDK's durable `queue()` so WebSocket and RPC
 * handlers return immediately and work resumes if the object is evicted.
 */
export class OrchestratorAgent extends Agent<Env, OrchestratorState> {
  override initialState: OrchestratorState = { activeRunId: null };

  private tablesReady = false;
  private cachedUserKind: UserKind | undefined;

  // ---------------------------------------------------------------- identity

  private get identity(): { userId: string; conversationId: string } {
    const parsed = parseOrchestratorName(this.name);
    if (!parsed) throw new Error(`Invalid orchestrator name: ${this.name}`);
    return parsed;
  }

  private logger(run?: Pick<RunRow, "id" | "trace_id">): Logger {
    return createLogger({ agent: "orchestrator", instance: this.name, runId: run?.id, traceId: run?.trace_id });
  }

  private llmFor(run: RunRow): LLMClient {
    const { userId, conversationId } = this.identity;
    return createLLM(this.env, { userId, conversationId, agent: "orchestrator", traceId: run.trace_id, runId: run.id });
  }

  // ------------------------------------------------------------------ schema

  private ensureTables(): void {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      run_id TEXT,
      sources_json TEXT,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT,
      client_mode TEXT NOT NULL,
      request TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      rationale TEXT,
      memories_json TEXT NOT NULL DEFAULT '[]',
      workflow_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      input TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT,
      sources_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )`;
    this.tablesReady = true;
  }

  private getRun(runId: string): RunRow | undefined {
    this.ensureTables();
    return this.sql<RunRow>`SELECT * FROM runs WHERE id = ${runId}`[0];
  }

  private getSubtasks(runId: string): Subtask[] {
    this.ensureTables();
    return this.sql<SubtaskRow>`SELECT * FROM subtasks WHERE run_id = ${runId} ORDER BY created_at, id`.map(toSubtask);
  }

  private setRunStatus(runId: string, status: RunStatus, error: string | null = null): void {
    const finished = status === "done" || status === "failed" ? Date.now() : null;
    this.sql`UPDATE runs SET status = ${status}, error = ${error}, finished_at = ${finished} WHERE id = ${runId}`;
  }

  // ----------------------------------------------------------- client events

  private send(connection: Connection, event: ServerEvent): void {
    connection.send(JSON.stringify(event));
  }

  private emit(event: ServerEvent): void {
    this.broadcast(JSON.stringify(event));
  }

  override async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    this.ensureTables();
    const messages = this.sql<{
      id: string;
      role: "user" | "assistant";
      content: string;
      run_id: string | null;
      sources_json: string | null;
      created_at: number;
    }>`SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT 50) ORDER BY created_at`;
    this.send(connection, {
      type: "history",
      messages: messages.map(
        (m): ChatMessageView => ({
          id: m.id,
          role: m.role,
          content: m.content,
          runId: m.run_id,
          sources: m.sources_json ? (JSON.parse(m.sources_json) as Source[]) : [],
          createdAt: m.created_at,
        }),
      ),
    });
    const active = this.state.activeRunId ? this.getRun(this.state.activeRunId) : undefined;
    if (active && ACTIVE.has(active.status)) this.replayRun(connection, active);
  }

  /** Lets a reconnecting client (or a second tab) catch up on an in-flight run. */
  private replayRun(connection: Connection, run: RunRow): void {
    if (!run.mode) return;
    const subtasks = this.getSubtasks(run.id);
    this.send(connection, {
      type: "plan",
      runId: run.id,
      mode: run.mode,
      rationale: run.rationale ?? "",
      subtasks: subtasks.map(({ id, agent, input, dependsOn }) => ({ id, agent, input, dependsOn })),
    });
    for (const s of subtasks) {
      this.send(connection, {
        type: "subtask",
        runId: run.id,
        taskId: s.id,
        agent: s.agent,
        status: s.status,
        output: s.output?.slice(0, EVENT_OUTPUT_CHARS),
        error: s.error ?? undefined,
      });
    }
  }

  override async onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (typeof message !== "string") return;
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return this.send(connection, { type: "error", code: "bad_request", message: "Messages must be JSON" });
    }
    // Ignore Agents SDK protocol frames; only handle our chat messages.
    if ((data as { type?: unknown })?.type !== "chat") return;
    const parsed = ClientMessageSchema.safeParse(data);
    if (!parsed.success) {
      return this.send(connection, { type: "error", code: "bad_request", message: "Message must be 1-4000 characters" });
    }
    try {
      await this.startRun(parsed.data.text, parsed.data.mode);
    } catch (err) {
      const code = err instanceof AppError ? err.code : "internal";
      this.send(connection, { type: "error", code, message: errorMessage(err) });
    }
  }

  // --------------------------------------------------------------- run start

  private async userKind(): Promise<UserKind> {
    if (this.cachedUserKind) return this.cachedUserKind;
    const row = await this.env.DB.prepare(`SELECT kind FROM users WHERE id = ?`)
      .bind(this.identity.userId)
      .first<{ kind: UserKind }>();
    if (!row) throw new AppError(401, "unauthorized", "Unknown user");
    this.cachedUserKind = row.kind;
    return row.kind;
  }

  private async startRun(text: string, clientMode: "auto" | "deep"): Promise<string> {
    this.ensureTables();
    const { userId, conversationId } = this.identity;

    const activeId = this.state.activeRunId;
    const active = activeId ? this.getRun(activeId) : undefined;
    if (active && ACTIVE.has(active.status)) {
      throw new AppError(409, "run_in_progress", "Wait for the current answer to finish");
    }

    const { success } = await this.env.MESSAGE_LIMITER.limit({ key: userId });
    if (!success) throw new AppError(429, "rate_limited", "Too many messages, try again in a minute");
    await assertWithinBudget(this.env, { userId, kind: await this.userKind() });

    // Re-check after the awaits above: another message may have started a run meanwhile.
    if (this.state.activeRunId && this.state.activeRunId !== activeId) {
      const latest = this.getRun(this.state.activeRunId);
      if (latest && ACTIVE.has(latest.status)) {
        throw new AppError(409, "run_in_progress", "Wait for the current answer to finish");
      }
    }

    const runId = newId("run");
    const traceId = newId("trc");
    const messageId = newId("msg");
    const now = Date.now();
    this.sql`INSERT INTO messages (id, role, content, run_id, created_at)
      VALUES (${messageId}, 'user', ${text}, ${runId}, ${now})`;
    this.sql`INSERT INTO runs (id, status, client_mode, request, trace_id, created_at)
      VALUES (${runId}, 'planning', ${clientMode}, ${text}, ${traceId}, ${now})`;
    this.setState({ activeRunId: runId });
    this.emit({ type: "run_started", runId, traceId, mode: clientMode, text, messageId });

    const { limits } = await getConfig(this.env);
    const timeout =
      clientMode === "deep" ? DEEP_RESEARCH_TIMEOUT_SECONDS : limits.runTimeoutSeconds + PLANNING_GRACE_SECONDS;
    await this.schedule(timeout, "onRunTimeout", { runId });
    await this.queue("planRun", { runId });

    await this.env.DB.prepare(
      `INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
         title = CASE WHEN conversations.title = 'New conversation' THEN excluded.title ELSE conversations.title END`,
    )
      .bind(conversationId, userId, text.slice(0, 60), now, now)
      .run();
    await audit(this.env.DB, { userId, action: "run.started", target: runId, meta: { conversationId, clientMode } });
    this.logger({ id: runId, trace_id: traceId }).info("run started", { clientMode });
    return runId;
  }

  // ---------------------------------------------------------------- planning

  /** Durable queue callback: recall memories, plan, and start execution. */
  async planRun({ runId }: { runId: string }): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.status !== "planning") return;
    const log = this.logger(run);
    const { userId, conversationId } = this.identity;
    try {
      const llm = this.llmFor(run);
      const [config, history, memories, docCount] = await Promise.all([
        getConfig(this.env),
        Promise.resolve(this.historyText(run.id)),
        this.recallMemories(llm, run.request),
        this.readyDocumentCount(),
      ]);

      const plan: Plan =
        run.client_mode === "deep"
          ? { mode: "deep_research", rationale: "Deep research requested.", subtasks: [] }
          : await planRequest(llm, {
              request: run.request,
              history,
              memories,
              docCount,
              maxSubtasks: config.limits.maxSubtasks,
            });

      // The run may have timed out while the planner was thinking.
      if (this.getRun(runId)?.status !== "planning") return;

      const subtasks = plan.subtasks.map((s) => ({
        ...s,
        id: `${runId}_${s.id}`,
        dependsOn: s.dependsOn.map((d) => `${runId}_${d}`),
      }));
      const now = Date.now();
      this.sql`UPDATE runs SET mode = ${plan.mode}, rationale = ${plan.rationale},
        memories_json = ${JSON.stringify(memories)}, status = 'running' WHERE id = ${runId}`;
      for (const s of subtasks) {
        this.sql`INSERT INTO subtasks (id, run_id, agent, input, depends_on, status, created_at)
          VALUES (${s.id}, ${runId}, ${s.agent}, ${s.input}, ${JSON.stringify(s.dependsOn)}, 'pending', ${now})`;
      }
      this.emit({ type: "plan", runId, mode: plan.mode, rationale: plan.rationale, subtasks });
      log.info("planned", { mode: plan.mode, subtasks: subtasks.length });

      if (plan.mode === "direct") {
        await this.answerDirect(this.getRun(runId)!, llm, history, memories);
      } else if (plan.mode === "deep_research") {
        const params: DeepResearchParams = { runId, userId, conversationId, question: run.request, traceId: run.trace_id };
        const workflowId = await this.runWorkflow("DEEP_RESEARCH_WORKFLOW", params);
        this.sql`UPDATE runs SET workflow_id = ${workflowId} WHERE id = ${runId}`;
      } else {
        if (subtasks.length) {
          await this.env.DB.batch(
            subtasks.map((s) =>
              this.env.DB.prepare(
                `INSERT INTO tasks (id, run_id, conversation_id, user_id, agent, input, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
              ).bind(s.id, runId, conversationId, userId, s.agent, s.input, now),
            ),
          );
        }
        await this.dispatchReady(runId);
      }
    } catch (err) {
      await this.failRun(runId, err);
    }
  }

  private historyText(currentRunId: string): string {
    const rows = this.sql<{ role: string; content: string }>`
      SELECT role, content FROM messages WHERE run_id IS NULL OR run_id != ${currentRunId}
      ORDER BY created_at DESC LIMIT ${HISTORY_MESSAGES}`;
    return rows
      .reverse()
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 600)}`)
      .join("\n");
  }

  private async recallMemories(llm: LLMClient, request: string): Promise<string[]> {
    try {
      const [vector] = await llm.embed([request]);
      if (!vector) return [];
      const matches = await createVectorStore(this.env).query(this.identity.userId, vector, { topK: 5, kind: "memory" });
      return matches
        .filter((m) => m.score >= MEMORY_MIN_SCORE && m.metadata.text)
        .map((m) => m.metadata.text as string);
    } catch (err) {
      this.logger().warn("memory recall failed", { err: errorMessage(err) });
      return [];
    }
  }

  private async readyDocumentCount(): Promise<number> {
    const row = await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'ready'`)
      .bind(this.identity.userId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  private async answerDirect(run: RunRow, llm: LLMClient, history: string, memories: string[]): Promise<void> {
    this.setRunStatus(run.id, "synthesizing");
    const stream = await llm.stream({
      purpose: "direct",
      messages: directMessages({ request: run.request, history, memories }),
      maxTokens: 800,
      temperature: 0.5,
    });
    const text = await this.relay(run.id, stream);
    await this.finalize(run.id, text, []);
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * Sends every subtask whose dependencies have settled to the queue. Status
   * updates happen synchronously before any await, so concurrent result
   * callbacks cannot dispatch the same subtask twice.
   */
  private async dispatchReady(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.status !== "running") return;
    const subtasks = this.getSubtasks(runId);
    const ready = readySubtasks(subtasks);

    if (ready.length) {
      const { userId, conversationId } = this.identity;
      const byId = new Map(subtasks.map((s) => [s.id, s]));
      const envelopes: SubtaskEnvelope[] = ready.map((s) => ({
        taskId: s.id,
        runId,
        traceId: run.trace_id,
        userId,
        conversationId,
        orchestrator: this.name,
        agent: s.agent,
        input: s.input,
        question: run.request,
        context: s.dependsOn
          .map((d) => byId.get(d))
          .filter((d): d is Subtask => d?.status === "completed")
          .map((d) => ({ taskId: d.id, agent: d.agent, output: (d.output ?? "").slice(0, CONTEXT_CHARS) })),
      }));
      for (const s of ready) this.sql`UPDATE subtasks SET status = 'queued' WHERE id = ${s.id}`;

      try {
        await this.env.AGENT_TASKS.sendBatch(
          envelopes.map((envelope) => ({ body: { kind: "subtask", envelope } satisfies QueueMessage, contentType: "json" })),
        );
        await this.updateTasks(
          ready.map((s) => s.id),
          "queued",
        );
        for (const s of ready) this.emit({ type: "subtask", runId, taskId: s.id, agent: s.agent, status: "queued" });
      } catch (err) {
        const error = `Dispatch failed: ${errorMessage(err)}`;
        for (const s of ready) {
          this.sql`UPDATE subtasks SET status = 'failed', error = ${error}, completed_at = ${Date.now()} WHERE id = ${s.id}`;
          this.emit({ type: "subtask", runId, taskId: s.id, agent: s.agent, status: "failed", error });
        }
        await this.updateTasks(
          ready.map((s) => s.id),
          "failed",
          error,
        );
        return this.dispatchReady(runId);
      }
    }

    if (allSettled(this.getSubtasks(runId))) await this.beginSynthesis(runId);
  }

  private async updateTasks(ids: string[], status: SubtaskStatus, error: string | null = null): Promise<void> {
    if (!ids.length) return;
    const completedAt = TERMINAL_STATUSES.has(status) ? Date.now() : null;
    try {
      await this.env.DB.batch(
        ids.map((id) =>
          this.env.DB.prepare(`UPDATE tasks SET status = ?, error = ?, completed_at = ? WHERE id = ?`).bind(
            status,
            error,
            completedAt,
            id,
          ),
        ),
      );
    } catch (err) {
      this.logger().warn("task mirror update failed", { err: errorMessage(err) });
    }
  }

  /** RPC from the queue consumer when a specialist picks a subtask up. */
  async markSubtaskRunning(runId: string, taskId: string, attempt: number): Promise<boolean> {
    this.ensureTables();
    const [row] = this.sql<SubtaskRow>`SELECT * FROM subtasks WHERE id = ${taskId} AND run_id = ${runId}`;
    if (!row || TERMINAL_STATUSES.has(row.status)) return false;
    if (row.status !== "running") {
      this.sql`UPDATE subtasks SET status = 'running' WHERE id = ${taskId}`;
      this.emit({ type: "subtask", runId, taskId, agent: row.agent, status: "running" });
    }
    try {
      await this.env.DB.prepare(`UPDATE tasks SET status = 'running', attempts = ? WHERE id = ?`).bind(attempt, taskId).run();
    } catch (err) {
      this.logger().warn("task mirror update failed", { err: errorMessage(err) });
    }
    return true;
  }

  /** RPC from the queue consumer (or the DLQ consumer) with a specialist's result. */
  async onSubtaskResult(result: SubtaskResult): Promise<{ accepted: boolean }> {
    this.ensureTables();
    const [row] = this.sql<SubtaskRow>`SELECT * FROM subtasks WHERE id = ${result.taskId} AND run_id = ${result.runId}`;
    const run = this.getRun(result.runId);
    // Late or duplicate deliveries (after a timeout, or a queue redelivery) are dropped.
    if (!row || !run || run.status !== "running" || TERMINAL_STATUSES.has(row.status)) return { accepted: false };

    this.sql`UPDATE subtasks SET status = ${result.status}, output = ${result.output},
      sources_json = ${JSON.stringify(result.sources)}, error = ${result.error ?? null},
      completed_at = ${Date.now()} WHERE id = ${result.taskId}`;
    this.emit({
      type: "subtask",
      runId: result.runId,
      taskId: result.taskId,
      agent: result.agent,
      status: result.status,
      output: result.output.slice(0, EVENT_OUTPUT_CHARS),
      error: result.error,
      sources: result.sources,
    });
    await this.updateTasks([result.taskId], result.status, result.error ?? null);
    this.logger(run).info("subtask settled", { taskId: result.taskId, status: result.status, durationMs: result.durationMs });
    await this.dispatchReady(result.runId);
    return { accepted: true };
  }

  /** Scheduled per run. Unfinished subtasks are timed out and the run finishes with partial results. */
  async onRunTimeout({ runId }: { runId: string }): Promise<void> {
    const run = this.getRun(runId);
    if (!run) return;
    if (run.status === "planning" || (run.status === "running" && run.mode === "deep_research")) {
      return this.failRun(runId, new AppError(504, "timeout", "The run took too long and was stopped"));
    }
    if (run.status !== "running") return;

    const pending = this.getSubtasks(runId).filter((s) => !TERMINAL_STATUSES.has(s.status));
    for (const s of pending) {
      this.sql`UPDATE subtasks SET status = 'timed_out', completed_at = ${Date.now()} WHERE id = ${s.id}`;
      this.emit({ type: "subtask", runId, taskId: s.id, agent: s.agent, status: "timed_out" });
    }
    await this.updateTasks(
      pending.map((s) => s.id),
      "timed_out",
    );
    this.logger(run).warn("run timed out", { pending: pending.length });
    await this.beginSynthesis(runId);
  }

  // --------------------------------------------------------------- synthesis

  private async beginSynthesis(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.status !== "running") return;
    this.setRunStatus(runId, "synthesizing");
    await this.queue("synthesizeRun", { runId });
  }

  /** Durable queue callback: stream the merged answer from the SummarizerAgent. */
  async synthesizeRun({ runId }: { runId: string }): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.status !== "synthesizing") return;
    const { userId, conversationId } = this.identity;
    try {
      const { results, sources } = mergeResults(this.getSubtasks(runId));
      const summarizer = await getAgentByName(
        this.env.SummarizerAgent as unknown as DurableObjectNamespace<SummarizerAgent>,
        userId,
      );
      const bytes = await summarizer.synthesize({
        userId,
        conversationId,
        traceId: run.trace_id,
        runId,
        question: run.request,
        history: this.historyText(runId),
        memories: JSON.parse(run.memories_json) as string[],
        results,
        sources,
      });
      const text = await this.relay(runId, bytes.pipeThrough(new TextDecoderStream()));
      await this.finalize(runId, text, sources);
    } catch (err) {
      await this.failRun(runId, err);
    }
  }

  /** Forwards streamed text to clients in small batches and returns the full text. */
  private async relay(runId: string, stream: ReadableStream<string>): Promise<string> {
    let full = "";
    let pending = "";
    let lastFlush = Date.now();
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      full += value;
      pending += value;
      if (pending.length >= 48 || Date.now() - lastFlush > 80) {
        this.emit({ type: "token", runId, text: pending });
        pending = "";
        lastFlush = Date.now();
      }
    }
    if (pending) this.emit({ type: "token", runId, text: pending });
    return full.trim();
  }

  private async finalize(runId: string, content: string, sources: Source[], reportUrl?: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.status === "done" || run.status === "failed") return;
    const { userId, conversationId } = this.identity;
    const messageId = newId("msg");
    const answer = content || "I could not produce an answer this time. Please try again.";

    this.sql`INSERT INTO messages (id, role, content, run_id, sources_json, created_at)
      VALUES (${messageId}, 'assistant', ${answer}, ${runId}, ${JSON.stringify(sources)}, ${Date.now()})`;
    this.setRunStatus(runId, "done");
    if (this.state.activeRunId === runId) this.setState({ activeRunId: null });
    this.emit({ type: "final", runId, messageId, content: answer, sources, reportUrl });

    await this.env.DB.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(Date.now(), conversationId, userId)
      .run();
    await audit(this.env.DB, { userId, action: "run.completed", target: runId, meta: { mode: run.mode } });
    this.logger(run).info("run completed", { mode: run.mode, durationMs: Date.now() - run.created_at });
    await this.queue("distillMemory", { runId });
  }

  /** Durable queue callback: store durable facts from this exchange as long-term memory. */
  async distillMemory({ runId }: { runId: string }): Promise<void> {
    const run = this.getRun(runId);
    if (!run) return;
    const [answer] = this.sql<{ content: string }>`
      SELECT content FROM messages WHERE run_id = ${runId} AND role = 'assistant' LIMIT 1`;
    if (!answer) return;
    const { userId, conversationId } = this.identity;
    try {
      const summarizer = await getAgentByName(
        this.env.SummarizerAgent as unknown as DurableObjectNamespace<SummarizerAgent>,
        userId,
      );
      await summarizer.distillMemories({
        userId,
        conversationId,
        traceId: run.trace_id,
        runId,
        question: run.request,
        answer: answer.content,
      });
    } catch (err) {
      this.logger(run).warn("memory distillation failed", { err: errorMessage(err) });
    }
  }

  private async failRun(runId: string, err: unknown): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.status === "done" || run.status === "failed") return;
    const message = errorMessage(err);
    this.setRunStatus(runId, "failed", message);
    if (this.state.activeRunId === runId) this.setState({ activeRunId: null });
    this.emit({ type: "error", runId, code: err instanceof AppError ? err.code : "run_failed", message });
    this.logger(run).error("run failed", { err: message });
    await audit(this.env.DB, { userId: this.identity.userId, action: "run.failed", target: runId, meta: { message } });
  }

  // ------------------------------------------------------ workflow callbacks

  override async onWorkflowProgress(_name: string, _workflowId: string, progress: unknown): Promise<void> {
    const p = progress as DeepResearchProgress;
    if (!p?.runId) return;
    this.emit({ type: "research_progress", runId: p.runId, step: p.step, message: p.message, percent: p.percent });
  }

  override async onWorkflowComplete(_name: string, _workflowId: string, result?: unknown): Promise<void> {
    const r = result as DeepResearchResult | undefined;
    if (!r?.runId) return;
    const run = this.getRun(r.runId);
    if (!run || run.status !== "running") return;
    this.setRunStatus(r.runId, "synthesizing");
    await this.finalize(r.runId, r.report, r.sources, `/api/reports/${r.runId}`);
  }

  override async onWorkflowError(_name: string, workflowId: string, error: string): Promise<void> {
    this.ensureTables();
    const [run] = this.sql<RunRow>`SELECT * FROM runs WHERE workflow_id = ${workflowId}`;
    if (run) await this.failRun(run.id, new AppError(502, "research_failed", `Deep research failed: ${error}`));
  }

  /** HTTP to the orchestrator is not used; clients talk over WebSocket. */
  override onRequest(): Response {
    return new Response("Use a WebSocket connection", { status: 426 });
  }
}

function toSubtask(row: SubtaskRow): Subtask {
  return {
    id: row.id,
    agent: row.agent,
    input: row.input,
    dependsOn: JSON.parse(row.depends_on) as string[],
    status: row.status,
    output: row.output,
    error: row.error,
    sources: row.sources_json ? (JSON.parse(row.sources_json) as Source[]) : [],
  };
}
