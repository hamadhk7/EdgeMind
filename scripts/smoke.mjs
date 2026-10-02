// Post-deploy smoke test: health, guest session, one full multi-agent run over WebSocket.
// Usage: npm run smoke -- https://edgemind.<subdomain>.workers.dev
const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const prompt = process.argv[3] ?? "What is Cloudflare Workers AI? Answer briefly.";

const check = (cond, message) => {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
};

const health = await fetch(`${base}/api/health`).then((r) => r.json());
check(health.status === "ok", `health ${JSON.stringify(health.checks)}`);

const session = await fetch(`${base}/api/session`, { method: "POST" }).then((r) => r.json());
check(session.token, `guest session ${session.userId}`);
const auth = { Authorization: `Bearer ${session.token}` };

const { conversation } = await fetch(`${base}/api/conversations`, { method: "POST", headers: auth }).then((r) => r.json());
check(conversation?.agentPath, `conversation ${conversation.id}`);

const wsUrl = `${base.replace(/^http/, "ws")}${conversation.agentPath}?token=${encodeURIComponent(session.token)}`;
const started = Date.now();
await new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  const timer = setTimeout(() => reject(new Error("timed out after 120s")), 120_000);
  ws.onopen = () => ws.send(JSON.stringify({ type: "chat", text: prompt }));
  ws.onerror = (e) => reject(new Error(`websocket error: ${e.message ?? e.type}`));
  ws.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    if (event.type === "plan") console.log(`  plan: ${event.mode} (${event.subtasks.length} subtasks) - ${event.rationale}`);
    if (event.type === "subtask") console.log(`  ${event.agent}: ${event.status}`);
    if (event.type === "error") {
      clearTimeout(timer);
      reject(new Error(`${event.code}: ${event.message}`));
    }
    if (event.type === "final") {
      clearTimeout(timer);
      console.log(`\n${event.content.slice(0, 600)}${event.content.length > 600 ? "…" : ""}\n`);
      ws.close();
      resolve();
    }
  };
});
check(true, `run finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const usage = await fetch(`${base}/api/usage`, { headers: auth }).then((r) => r.json());
check(usage.today.calls > 0, `usage recorded: ${usage.today.tokens} tokens, ~$${usage.today.costUsd.toFixed(5)}`);
