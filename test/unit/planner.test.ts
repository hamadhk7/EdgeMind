import { describe, expect, it } from "vitest";
import { allSettled, hasCycle, normalizePlan, readySubtasks } from "../../src/agents/planner";
import type { SubtaskStatus } from "../../src/lib/types";

const limits = { maxSubtasks: 4, docCount: 2 };

describe("normalizePlan", () => {
  it("accepts a valid delegate plan", () => {
    const plan = normalizePlan(
      {
        mode: "delegate",
        rationale: "Needs research",
        subtasks: [
          { id: "t1", agent: "research", input: "edge computing", dependsOn: [] },
          { id: "t2", agent: "code", input: "write a worker", dependsOn: ["t1"] },
        ],
      },
      limits,
    );
    expect(plan?.mode).toBe("delegate");
    expect(plan?.subtasks).toHaveLength(2);
    expect(plan?.subtasks[1]?.dependsOn).toEqual(["t1"]);
  });

  it("returns null for output that is not a plan", () => {
    expect(normalizePlan({ hello: "world" }, limits)).toBeNull();
    expect(normalizePlan(undefined, limits)).toBeNull();
    expect(normalizePlan({ mode: "delegate", subtasks: [{ id: "t1", agent: "wizard", input: "x" }] }, limits)).toBeNull();
  });

  it("drops rag subtasks when the user has no documents and falls back to direct", () => {
    const plan = normalizePlan(
      { mode: "delegate", subtasks: [{ id: "t1", agent: "rag", input: "what does my doc say" }] },
      { maxSubtasks: 4, docCount: 0 },
    );
    expect(plan?.mode).toBe("direct");
    expect(plan?.subtasks).toEqual([]);
  });

  it("caps the number of subtasks and removes duplicates and dangling dependencies", () => {
    const plan = normalizePlan(
      {
        mode: "delegate",
        subtasks: [
          { id: "t1", agent: "research", input: "a" },
          { id: "t1", agent: "research", input: "duplicate" },
          { id: "t2", agent: "research", input: "b", dependsOn: ["t9", "t2"] },
          { id: "t3", agent: "research", input: "c" },
          { id: "t4", agent: "research", input: "d" },
          { id: "t5", agent: "research", input: "e" },
        ],
      },
      limits,
    );
    expect(plan?.subtasks.map((s) => s.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(plan?.subtasks[1]?.dependsOn).toEqual([]);
  });

  it("breaks dependency cycles", () => {
    const plan = normalizePlan(
      {
        mode: "delegate",
        subtasks: [
          { id: "a", agent: "research", input: "a", dependsOn: ["b"] },
          { id: "b", agent: "code", input: "b", dependsOn: ["a"] },
        ],
      },
      limits,
    );
    expect(plan?.subtasks.every((s) => s.dependsOn.length === 0)).toBe(true);
  });

  it("clears subtasks for non-delegate modes", () => {
    const plan = normalizePlan(
      { mode: "direct", subtasks: [{ id: "t1", agent: "research", input: "x" }] },
      limits,
    );
    expect(plan).toEqual({ mode: "direct", rationale: "", subtasks: [] });
  });
});

describe("hasCycle", () => {
  it("detects direct and indirect cycles", () => {
    expect(hasCycle([{ id: "a", dependsOn: ["a"] }])).toBe(true);
    expect(
      hasCycle([
        { id: "a", dependsOn: ["c"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ]),
    ).toBe(true);
    expect(
      hasCycle([
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["a", "b"] },
      ]),
    ).toBe(false);
  });
});

describe("readySubtasks", () => {
  const task = (id: string, status: SubtaskStatus, dependsOn: string[] = []) => ({ id, status, dependsOn });

  it("returns pending tasks whose dependencies have settled", () => {
    const tasks = [
      task("t1", "completed"),
      task("t2", "pending", ["t1"]),
      task("t3", "pending", ["t4"]),
      task("t4", "running"),
      task("t5", "pending", ["t6"]),
      task("t6", "failed"),
    ];
    expect(readySubtasks(tasks).map((t) => t.id)).toEqual(["t2", "t5"]);
  });

  it("knows when all subtasks have settled", () => {
    expect(allSettled([task("a", "completed"), task("b", "timed_out"), task("c", "failed")])).toBe(true);
    expect(allSettled([task("a", "completed"), task("b", "queued")])).toBe(false);
  });
});
