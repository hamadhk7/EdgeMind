import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { createFileStore } from "../../src/lib/files";
import type { QueueMessage, ServerEvent, SubtaskEnvelope } from "../../src/lib/types";
import { BASE, call, connect, guest, json, newConversation, poll } from "../helpers";

type Final = Extract<ServerEvent, { type: "final" }>;
type PlanEvent = Extract<ServerEvent, { type: "plan" }>;

describe("orchestrator WebSocket auth", () => {
  it("rejects connections without a token or to another user's conversation", async () => {
    const alice = await guest();
    const bob = await guest();
    const convo = await newConversation(alice.token);

    const anonymous = await exports.default.fetch(new Request(`${BASE}${convo.agentPath}`, { headers: { Upgrade: "websocket" } }));
    expect(anonymous.status).toBe(401);

    const intruder = await exports.default.fetch(
      new Request(`${BASE}${convo.agentPath}?token=${bob.token}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(intruder.status).toBe(403);
  });

  it("does not expose specialist agents", async () => {
    const { token, userId } = await guest();
    const res = await exports.default.fetch(
      new Request(`${BASE}/agents/research-agent/${userId}?token=${token}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(404);
  });
});

describe("multi-agent runs", () => {
  it("answers small talk directly", async () => {
    const { token } = await guest();
    const convo = await newConversation(token);
    const socket = await connect(convo.agentPath, token);
    await socket.waitFor((e) => e.type === "history");

    socket.send({ type: "chat", text: "hello there" });
    const plan = (await socket.waitFor((e) => e.type === "plan")) as PlanEvent;
    expect(plan.mode).toBe("direct");
    const final = (await socket.waitFor((e) => e.type === "final")) as Final;
    expect(final.content).toContain("EdgeMind");
    expect(socket.events.some((e) => e.type === "token")).toBe(true);
    socket.close();
  });

  it("delegates to specialists over the queue, honours dependencies and synthesizes", async () => {
    const { token } = await guest();
    const convo = await newConversation(token);
    const socket = await connect(convo.agentPath, token);
    await socket.waitFor((e) => e.type === "history");

    socket.send({ type: "chat", text: "Explain Durable Objects and write code for a counter" });
    const plan = (await socket.waitFor((e) => e.type === "plan")) as PlanEvent;
    expect(plan.mode).toBe("delegate");
    expect(plan.subtasks.map((s) => s.agent)).toEqual(["research", "code"]);
    const [research, code] = plan.subtasks;
    expect(code?.dependsOn).toEqual([research?.id]);

    const final = (await socket.waitFor((e) => e.type === "final")) as Final;
    expect(final.content.length).toBeGreaterThan(0);
    expect(final.sources.length).toBeGreaterThan(0);

    // The code subtask may only start after research completed.
    const order = socket.events
      .filter((e): e is Extract<ServerEvent, { type: "subtask" }> => e.type === "subtask")
      .map((e) => `${e.agent}:${e.status}`);
    expect(order.indexOf("research:completed")).toBeLessThan(order.indexOf("code:queued"));
    expect(order).toContain("code:completed");

    // The D1 task mirror and usage table were written.
    const tasks = await json<{ tasks: Array<{ status: string }> }>(await call(`/api/conversations/${convo.id}/tasks`, { token }));
    expect(tasks.tasks.map((t) => t.status)).toEqual(["completed", "completed"]);
    const usage = await json<{ today: { tokens: number; calls: number } }>(await call("/api/usage", { token }));
    expect(usage.today.calls).toBeGreaterThan(0);
    socket.close();
  });

  it("rejects a second message while a run is in progress", async () => {
    const { token } = await guest();
    const convo = await newConversation(token);
    const socket = await connect(convo.agentPath, token);
    await socket.waitFor((e) => e.type === "history");

    socket.send({ type: "chat", text: "Tell me about Cloudflare Queues" });
    socket.send({ type: "chat", text: "And Workflows?" });
    const error = await socket.waitFor((e) => e.type === "error");
    expect(error).toMatchObject({ code: "run_in_progress" });
    await socket.waitFor((e) => e.type === "final");
    socket.close();
  });

  it("finishes with partial results when a subtask is dead-lettered", async () => {
    const { token } = await guest();
    const convo = await newConversation(token);
    const socket = await connect(convo.agentPath, token);
    await socket.waitFor((e) => e.type === "history");

    // The offline research agent throws for inputs containing [fail], so the queue keeps retrying it.
    socket.send({ type: "chat", text: "[fail] research something that breaks" });
    const plan = (await socket.waitFor((e) => e.type === "plan")) as PlanEvent;
    const failing = plan.subtasks[0]!;
    await socket.waitFor((e) => e.type === "subtask" && e.status === "running");

    // Simulate the message arriving on the dead-letter queue after max retries.
    const envelope: SubtaskEnvelope = {
      taskId: failing.id,
      runId: plan.runId,
      traceId: "trc_test",
      userId: convo.agentPath.split("/").pop()!.split("__")[0]!,
      conversationId: convo.id,
      orchestrator: convo.agentPath.split("/").pop()!,
      agent: failing.agent,
      input: failing.input,
      question: "",
      context: [],
    };
    const batch = createMessageBatch<QueueMessage>("edgemind-agent-tasks-dlq", [
      { id: "dlq-1", timestamp: new Date(), attempts: 1, body: { kind: "subtask", envelope } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["dlq-1"]);

    await socket.waitFor((e) => e.type === "subtask" && e.status === "failed");
    const final = (await socket.waitFor((e) => e.type === "final")) as Final;
    expect(final.content.length).toBeGreaterThan(0);
    socket.close();
  });

  it("runs deep research as a workflow and stores the report", async () => {
    const { token, userId } = await guest();
    const convo = await newConversation(token);
    const socket = await connect(convo.agentPath, token);
    await socket.waitFor((e) => e.type === "history");

    socket.send({ type: "chat", text: "Edge AI inference trends", mode: "deep" });
    const plan = (await socket.waitFor((e) => e.type === "plan")) as PlanEvent;
    expect(plan.mode).toBe("deep_research");
    const final = (await socket.waitFor((e) => e.type === "final", 30_000)) as Final;
    expect(final.reportUrl).toBe(`/api/reports/${plan.runId}`);
    expect(socket.events.some((e) => e.type === "research_progress")).toBe(true);

    const stored = await createFileStore(env).get(`reports/${userId}/${plan.runId}.md`);
    expect(await stored?.text()).toContain("Research report");
    const report = await call(final.reportUrl!, { token });
    expect(report.status).toBe(200);
    socket.close();
  });

  it("remembers durable facts across conversations", async () => {
    const { token } = await guest();
    const first = await newConversation(token);
    const socket = await connect(first.agentPath, token);
    await socket.waitFor((e) => e.type === "history");
    socket.send({ type: "chat", text: "hello, my name is Ada" });
    await socket.waitFor((e) => e.type === "final");
    socket.close();

    const memories = await poll(
      async () => (await json<{ memories: Array<{ text: string }> }>(await call("/api/memories", { token }))).memories,
      (m) => m.length > 0,
    );
    expect(memories[0]?.text).toContain("Ada");
  });

  it("replays history to a reconnecting client", async () => {
    const { token } = await guest();
    const convo = await newConversation(token);
    const socket = await connect(convo.agentPath, token);
    await socket.waitFor((e) => e.type === "history");
    socket.send({ type: "chat", text: "hi" });
    await socket.waitFor((e) => e.type === "final");
    socket.close();

    const again = await connect(convo.agentPath, token);
    const history = (await again.waitFor((e) => e.type === "history")) as Extract<ServerEvent, { type: "history" }>;
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    again.close();
  });
});
