import { z } from "zod";
import { SPECIALISTS, type Plan, type PlannedSubtask, type SubtaskStatus, TERMINAL_STATUSES } from "../lib/types";
import { extractJson, type LLMClient } from "../llm";
import { PLAN_REPAIR, plannerMessages } from "../llm/prompts";

const SubtaskSchema = z.object({
  id: z.string().trim().min(1).max(24),
  agent: z.enum(SPECIALISTS),
  input: z.string().trim().min(1).max(2000),
  dependsOn: z.array(z.string()).default([]),
});

const PlanSchema = z.object({
  mode: z.enum(["direct", "delegate", "deep_research"]),
  rationale: z.string().default(""),
  subtasks: z.array(SubtaskSchema).default([]),
});

export interface PlanLimits {
  maxSubtasks: number;
  docCount: number;
}

const DIRECT_FALLBACK: Plan = { mode: "direct", rationale: "Answering directly.", subtasks: [] };

/**
 * Validates raw planner output and normalizes it into an executable plan:
 * caps subtask count, drops impossible subtasks, removes dangling dependencies
 * and breaks cycles. Returns null if the output is not a plan at all.
 */
export function normalizePlan(raw: unknown, limits: PlanLimits): Plan | null {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) return null;
  const plan = parsed.data;
  const rationale = plan.rationale.slice(0, 500);

  if (plan.mode !== "delegate") return { mode: plan.mode, rationale, subtasks: [] };

  const seen = new Set<string>();
  let subtasks: PlannedSubtask[] = plan.subtasks
    .filter((s) => !(s.agent === "rag" && limits.docCount === 0))
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .slice(0, limits.maxSubtasks);

  const ids = new Set(subtasks.map((s) => s.id));
  subtasks = subtasks.map((s) => ({
    ...s,
    dependsOn: [...new Set(s.dependsOn)].filter((d) => d !== s.id && ids.has(d)),
  }));
  if (hasCycle(subtasks)) subtasks = subtasks.map((s) => ({ ...s, dependsOn: [] }));

  if (subtasks.length === 0) return { ...DIRECT_FALLBACK, rationale: rationale || DIRECT_FALLBACK.rationale };
  return { mode: "delegate", rationale, subtasks };
}

export function hasCycle(subtasks: Pick<PlannedSubtask, "id" | "dependsOn">[]): boolean {
  const deps = new Map(subtasks.map((s) => [s.id, s.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") return true;
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) if (visit(dep)) return true;
    state.set(id, "done");
    return false;
  };
  return subtasks.some((s) => visit(s.id));
}

/** Pending subtasks whose dependencies have all settled (completed, failed or timed out). */
export function readySubtasks<T extends { id: string; status: SubtaskStatus; dependsOn: string[] }>(subtasks: T[]): T[] {
  const status = new Map(subtasks.map((s) => [s.id, s.status]));
  return subtasks.filter(
    (s) => s.status === "pending" && s.dependsOn.every((d) => TERMINAL_STATUSES.has(status.get(d) ?? "pending")),
  );
}

export function allSettled(subtasks: Array<{ status: SubtaskStatus }>): boolean {
  return subtasks.every((s) => TERMINAL_STATUSES.has(s.status));
}

/** Asks the planner model for a plan, with one repair attempt, falling back to a direct answer. */
export async function planRequest(
  llm: LLMClient,
  input: { request: string; history: string; memories: string[] } & PlanLimits,
): Promise<Plan> {
  const messages = plannerMessages(input);
  const first = await llm.chat({ purpose: "plan", messages, json: true, temperature: 0.1, maxTokens: 700, cacheTtl: 600 });
  const plan = normalizePlan(extractJson(first.text), input);
  if (plan) return plan;

  const repaired = await llm.chat({
    purpose: "plan",
    messages: [...messages, { role: "assistant", content: first.text }, { role: "user", content: PLAN_REPAIR }],
    json: true,
    temperature: 0,
    maxTokens: 700,
  });
  return normalizePlan(extractJson(repaired.text), input) ?? DIRECT_FALLBACK;
}
