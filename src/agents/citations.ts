import type { Source, SpecialistKind, SubtaskStatus } from "../lib/types";

/** Shifts citation markers [n] (1 <= n <= count) by `offset` so merged source lists stay consistent. */
export function renumberCitations(text: string, count: number, offset: number): string {
  if (offset === 0 || count === 0) return text;
  return text.replace(/\[(\d+)\]/g, (match, n: string) => {
    const num = Number(n);
    return num >= 1 && num <= count ? `[${num + offset}]` : match;
  });
}

export interface SettledSubtask {
  agent: SpecialistKind;
  status: SubtaskStatus;
  output: string | null;
  error: string | null;
  sources: Source[];
}

/**
 * Each specialist numbers its own sources from [1]. Before synthesis, merge all
 * source lists into one and renumber each agent's citations to match it.
 */
export function mergeResults(subtasks: SettledSubtask[]): {
  results: Array<{ agent: SpecialistKind; status: SubtaskStatus; output: string }>;
  sources: Source[];
} {
  const sources: Source[] = [];
  const results = subtasks.map((s) => {
    const body = s.status === "completed" ? (s.output ?? "") : `(${s.status}: ${s.error ?? "no result"})`;
    const output = renumberCitations(body, s.sources.length, sources.length);
    if (s.status === "completed") sources.push(...s.sources);
    return { agent: s.agent, status: s.status, output };
  });
  return { results, sources };
}
