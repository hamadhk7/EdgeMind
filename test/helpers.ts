import { exports } from "cloudflare:workers";
import type { ServerEvent } from "../src/lib/types";

export const BASE = "https://edgemind.test";

export function call(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let ipCounter = 0;

/** New guest user. Each call uses a fresh IP so the per-IP session limiter does not trip. */
export async function guest(): Promise<{ token: string; userId: string }> {
  const res = await call("/api/session", {
    method: "POST",
    headers: { "cf-connecting-ip": `10.0.0.${++ipCounter}` },
  });
  if (res.status !== 201) throw new Error(`session failed: ${res.status} ${await res.text()}`);
  return json(res);
}

export async function newConversation(token: string): Promise<{ id: string; agentPath: string }> {
  const res = await call("/api/conversations", { method: "POST", token });
  const body = await json<{ conversation: { id: string; agentPath: string } }>(res);
  return body.conversation;
}

export interface AgentSocket {
  ws: WebSocket;
  events: ServerEvent[];
  send(message: unknown): void;
  waitFor(predicate: (e: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  close(): void;
}

/** Opens the orchestrator WebSocket the same way the browser UI does. */
export async function connect(agentPath: string, token: string): Promise<AgentSocket> {
  const res = await exports.default.fetch(
    new Request(`${BASE}${agentPath}?token=${encodeURIComponent(token)}`, { headers: { Upgrade: "websocket" } }),
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`WebSocket upgrade failed: ${res.status} ${await res.text()}`);
  ws.accept();

  const events: ServerEvent[] = [];
  const waiters: Array<{ predicate: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }> = [];
  ws.addEventListener("message", (msg) => {
    if (typeof msg.data !== "string") return;
    const event = JSON.parse(msg.data) as ServerEvent;
    events.push(event);
    for (const w of [...waiters]) {
      if (w.predicate(event)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
    }
  });

  return {
    ws,
    events,
    send: (message) => ws.send(JSON.stringify(message)),
    waitFor(predicate, timeoutMs = 20_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for event. Seen: ${events.map((e) => e.type).join(", ")}`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close: () => ws.close(),
  };
}

export async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error("poll timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}
