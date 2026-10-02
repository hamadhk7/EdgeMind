import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, guest, json, newConversation, poll } from "../helpers";

describe("health", () => {
  it("reports binding health", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    const body = await json<{ status: string; offline: boolean; checks: Record<string, { ok: boolean }> }>(res);
    expect(body.status).toBe("ok");
    expect(body.offline).toBe(true);
    expect(res.headers.get("x-trace-id")).toMatch(/^trc_/);
  });
});

describe("sessions and auth", () => {
  it("issues a guest token that authenticates /api/me", async () => {
    const { token, userId } = await guest();
    const me = await json<{ userId: string; kind: string; usage: { dailyBudget: number } }>(
      await call("/api/me", { token }),
    );
    expect(me).toMatchObject({ userId, kind: "guest" });
    expect(me.usage.dailyBudget).toBe(20_000);
  });

  it("refreshes a guest token for the same user", async () => {
    const { token, userId } = await guest();
    const res = await call("/api/session", { method: "POST", token });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ userId, refreshed: true });
  });

  it("rejects missing and forged tokens", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", { token: "garbage" })).status).toBe(401);
    expect((await call("/api/me", { token: "em_not_a_real_key" })).status).toBe(401);
    const body = await json<{ error: { code: string } }>(await call("/api/me"));
    expect(body.error.code).toBe("unauthorized");
  });

  it("rate limits session creation per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await call("/api/session", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } })).status);
    }
    expect(statuses).toContain(201);
    expect(statuses).toContain(429);
  });
});

describe("admin API keys", () => {
  it("requires the admin token", async () => {
    expect((await call("/api/admin/keys", { method: "POST", token: "wrong" })).status).toBe(401);
  });

  it("creates, uses and revokes an API key", async () => {
    const created = await call("/api/admin/keys", {
      method: "POST",
      token: "test-admin-token",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ci" }),
    });
    expect(created.status).toBe(201);
    const { apiKey, keyId, userId } = await json<{ apiKey: string; keyId: string; userId: string }>(created);
    expect(apiKey).toMatch(/^em_/);

    const me = await json<{ userId: string; kind: string }>(await call("/api/me", { token: apiKey }));
    expect(me).toMatchObject({ userId, kind: "key" });

    const stored = await env.DB.prepare("SELECT key_hash FROM api_keys WHERE id = ?").bind(keyId).first<{ key_hash: string }>();
    expect(stored?.key_hash).not.toContain(apiKey);

    expect((await call(`/api/admin/keys/${keyId}`, { method: "DELETE", token: "test-admin-token" })).status).toBe(204);
    expect((await call("/api/me", { token: apiKey })).status).toBe(401);
  });

  it("validates the request body", async () => {
    const res = await call("/api/admin/keys", {
      method: "POST",
      token: "test-admin-token",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("conversations", () => {
  it("creates and lists only the caller's conversations", async () => {
    const alice = await guest();
    const bob = await guest();
    const convo = await newConversation(alice.token);
    expect(convo.agentPath).toBe(`/agents/orchestrator-agent/${alice.userId}__${convo.id}`);

    const mine = await json<{ conversations: Array<{ id: string }> }>(await call("/api/conversations", { token: alice.token }));
    expect(mine.conversations.map((c) => c.id)).toContain(convo.id);
    const theirs = await json<{ conversations: Array<{ id: string }> }>(await call("/api/conversations", { token: bob.token }));
    expect(theirs.conversations.map((c) => c.id)).not.toContain(convo.id);
    expect((await call(`/api/conversations/${convo.id}/tasks`, { token: bob.token })).status).toBe(404);
  });
});

describe("documents", () => {
  it("ingests a text document through the workflow into chunks and vectors", async () => {
    const { token, userId } = await guest();
    const form = new FormData();
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: Durable Objects give each agent its own SQLite storage.`).join("\n\n");
    form.append("file", new File([text], "notes.md", { type: "text/markdown" }));

    const res = await call("/api/documents", { method: "POST", token, body: form });
    expect(res.status).toBe(202);
    const { document } = await json<{ document: { id: string; status: string } }>(res);
    expect(document.status).toBe("queued");

    const ready = await poll(
      async () => (await json<{ document: { status: string; chunkCount: number } }>(await call(`/api/documents/${document.id}`, { token }))).document,
      (d) => d.status === "ready" || d.status === "failed",
    );
    expect(ready.status).toBe("ready");
    expect(ready.chunkCount).toBeGreaterThan(0);

    const vectors = await env.DB.prepare("SELECT COUNT(*) AS n FROM offline_vectors WHERE user_id = ? AND kind = 'doc'")
      .bind(userId)
      .first<{ n: number }>();
    expect(vectors?.n).toBe(ready.chunkCount);

    expect((await call(`/api/documents/${document.id}`, { method: "DELETE", token })).status).toBe(204);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?").bind(document.id).first<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  it("rejects unsupported file types and empty uploads", async () => {
    const { token } = await guest();
    const exe = new FormData();
    exe.append("file", new File(["MZ"], "tool.exe"));
    expect((await call("/api/documents", { method: "POST", token, body: exe })).status).toBe(415);
    const empty = new FormData();
    empty.append("file", new File([], "empty.txt"));
    expect((await call("/api/documents", { method: "POST", token, body: empty })).status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("returns JSON 404s", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: "not_found", message: "Route not found" } });
  });
});
