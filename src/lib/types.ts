/** Specialist agents that receive subtasks over the queue. */
export const SPECIALISTS = ["research", "rag", "code"] as const;
export type SpecialistKind = (typeof SPECIALISTS)[number];
export type AgentKind = SpecialistKind | "summarizer" | "orchestrator" | "ingest";

export type UserKind = "guest" | "key";

export interface Principal {
  userId: string;
  kind: UserKind;
}

export interface Source {
  title: string;
  url?: string;
  snippet?: string;
  documentId?: string;
}

/** Message body sent through the `agent-tasks` queue. */
export interface SubtaskEnvelope {
  taskId: string;
  runId: string;
  traceId: string;
  userId: string;
  conversationId: string;
  /** Orchestrator Durable Object instance name (`<userId>__<conversationId>`). */
  orchestrator: string;
  agent: SpecialistKind;
  /** Instruction written by the planner for this specialist. */
  input: string;
  /** The user's original request, for grounding. */
  question: string;
  /** Results of the subtasks this one depends on. */
  context: Array<{ taskId: string; agent: SpecialistKind; output: string }>;
}

export interface QueueMessage {
  kind: "subtask";
  envelope: SubtaskEnvelope;
}

export type SubtaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out";

export const TERMINAL_STATUSES: ReadonlySet<SubtaskStatus> = new Set([
  "completed",
  "failed",
  "timed_out",
]);

export interface SubtaskResult {
  taskId: string;
  runId: string;
  agent: SpecialistKind;
  status: "completed" | "failed";
  output: string;
  sources: Source[];
  error?: string;
  durationMs: number;
}

export type RunMode = "direct" | "delegate" | "deep_research";
export type RunStatus = "planning" | "running" | "synthesizing" | "done" | "failed";

export interface PlannedSubtask {
  id: string;
  agent: SpecialistKind;
  input: string;
  dependsOn: string[];
}

export interface Plan {
  mode: RunMode;
  rationale: string;
  subtasks: PlannedSubtask[];
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId: string | null;
  sources: Source[];
  createdAt: number;
}

/** Messages the server pushes to WebSocket clients. */
export type ServerEvent =
  | { type: "history"; messages: ChatMessageView[] }
  | { type: "run_started"; runId: string; traceId: string; mode: "auto" | "deep"; text: string; messageId: string }
  | { type: "plan"; runId: string; mode: RunMode; rationale: string; subtasks: PlannedSubtask[] }
  | {
      type: "subtask";
      runId: string;
      taskId: string;
      agent: SpecialistKind;
      status: SubtaskStatus;
      output?: string;
      error?: string;
      sources?: Source[];
    }
  | { type: "research_progress"; runId: string; step: string; message: string; percent?: number }
  | { type: "token"; runId: string; text: string }
  | {
      type: "final";
      runId: string;
      messageId: string;
      content: string;
      sources: Source[];
      reportUrl?: string;
    }
  | { type: "error"; runId?: string; code: string; message: string };

/** Messages clients send over the WebSocket. */
export interface ClientChatMessage {
  type: "chat";
  text: string;
  mode?: "auto" | "deep";
}
