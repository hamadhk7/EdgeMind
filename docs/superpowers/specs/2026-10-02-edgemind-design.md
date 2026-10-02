# EdgeMind — Design Spec

Date: 2026-10-02
Status: Approved design, pending implementation plan

## 1. Purpose

EdgeMind is a portfolio project: a serverless multi-agent AI backend on Cloudflare's edge. An orchestrator agent breaks a user request into subtasks, routes them to specialist agents, and combines the results into one answer, streamed to the client over WebSockets.

Definition of done:

- Deployed live demo on a **Cloudflare Workers Free** account (all services used are available on Free as of 2026-10).
- Built-in web chat UI that shows the live agent trace (plan → per-agent progress → streamed final answer).
- Visitors can try it without signing up (guest tokens) without exhausting the free quota (rate limits + daily token budget).
- Clean TypeScript codebase, automated tests, README with architecture diagram, one-command resource provisioning script, CI (typecheck + test).

Out of scope: code execution sandbox, user passwords/signup, billing, multi-region data residency, a separate frontend framework.

## 2. Free-plan constraints that shape the design

| Constraint | Impact |
|---|---|
| Workers AI: 10,000 neurons/day | Daily per-user token budget; cheap models for planning; AI Gateway caching |
| Workers CPU: 10 ms per invocation | Keep CPU work small (LLM/network waits do not count); chunking runs in Workflow steps |
| Queues: 10,000 ops/day, 24h retention | ≤4 subtasks per request; DLQ for failures |
| Workflows: 100 concurrent instances, 10 ms CPU/step, 1 MiB step result | Deep research capped at 3 rounds; large outputs stored in R2, steps return keys |
| Some Workers AI models now Paid-only (e.g. kimi-k2.6, glm-5.2) | Model IDs live in KV config; defaults use Free-plan models |
| Durable Objects: SQLite-backed only | All agents use `new_sqlite_classes` migrations |

## 3. Architecture

A single Worker (Hono router) exports everything:

- `/api/*` — auth, document upload, conversations, usage, health.
- `/agents/*` — `routeAgentRequest` from the Agents SDK; auth checked before the WebSocket upgrade.
- Static assets — the chat UI (`public/`).
- `queue()` handler — consumes `agent-tasks` and `agent-tasks-dlq`.
- Workflow classes — `IngestDocumentWorkflow`, `DeepResearchWorkflow`.
- Durable Object (agent) classes listed below.

### 3.1 Agents

All agents extend `Agent` from the `agents` package and are SQLite-backed Durable Objects.

| Agent | Instance name | Responsibility |
|---|---|---|
| `OrchestratorAgent` | `<userId>__<conversationId>` | Holds conversation history and run state. Plans each user turn with an LLM, dispatches subtasks, collects results, streams events to connected clients. Only agent reachable from outside. |
| `ResearchAgent` | `<userId>` | Web lookup (Wikipedia REST API; Tavily if `TAVILY_API_KEY` is set). Returns findings with source URLs. |
| `RagAgent` | `<userId>` | Semantic search over the user's documents and memories in Vectorize, returns a grounded answer with citations. |
| `CodeAgent` | `<userId>` | Writes, explains, or reviews code. No execution. |
| `SummarizerAgent` | `<userId>` | Merges subtask results into the final answer (streamed). Distils durable facts into long-term memory. |

Specialists share a `SpecialistAgent` base class:

- `runTask(task: SubtaskEnvelope): Promise<SubtaskResult>` — RPC entry point.
- SQL `task_log` table; a task ID already present returns the stored result (idempotent; Queues deliver at-least-once).
- Each specialist implements `execute(task, ctx)`.

### 3.2 Queues

- `agent-tasks` — one message per subtask. Consumer settings: `max_batch_size: 4`, `max_retries: 3`, retry with exponential backoff, `dead_letter_queue: agent-tasks-dlq`.
- `agent-tasks-dlq` — consumer marks the subtask `failed` in D1 and notifies the orchestrator so the run can finish with partial results.

### 3.3 Workflows

- `IngestDocumentWorkflow` (`WorkflowEntrypoint`): steps `load` (R2 → Workers AI `toMarkdown` for PDF/DOCX/HTML; plain read for txt/md) → `chunk` (≈800 tokens, 100 overlap; chunk text written to D1) → `embed` (batches of 50, `@cf/baai/bge-base-en-v1.5`) → `upsert` (Vectorize, namespace = userId, metadata `kind=doc`) → `finalize` (D1 status `ready`, notify any open orchestrator). Unsupported type → `NonRetryableError`.
- `DeepResearchWorkflow` (`AgentWorkflow` from `agents/workflows`, started via `this.runWorkflow`): up to 3 rounds of `generate queries → research each → reflect (enough? gaps?)`, then `write report` → R2 `reports/<userId>/<runId>.md`. Progress via `reportProgress`; completion via `onWorkflowComplete` on the orchestrator.

### 3.4 LLM layer (`src/llm/`)

- `LLMClient` interface: `chat({ messages, model?, json?, stream?, meta })` and `embed(texts)`.
- Production implementation routes every call through AI Gateway:
  - Workers AI via `env.AI.run(model, input, { gateway: { id, cacheTtl, metadata } })`.
  - Fallback: second Workers AI model; or, if `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` secret is present, that provider through the same gateway.
  - Metadata `{ userId, agent, conversationId, traceId }` for Gateway cost analytics.
- Every call writes a `usage` row (model, provider, tokens in/out, estimated cost, cached flag, latency).
- Model per agent read from KV `config:models` (cached in memory 60 s), with code defaults that are Free-plan models.
- Tests use a `FakeLLMClient`.

## 4. Data flow

### 4.1 Chat turn

1. UI calls `POST /api/session` → guest JWT. UI opens WebSocket `/agents/orchestrator-agent/<userId>__<convId>?token=…`.
2. Client sends `{ type: "chat", text, mode?: "auto" | "deep" }`.
3. Orchestrator: budget check (D1 `usage` sum for today) → save message → recall top-5 memories (Vectorize, `kind=memory`) → planner LLM call (JSON) returns one of:
   - `direct` — answer itself (streamed).
   - `delegate` — 1–4 subtasks `{ id, agent, input, dependsOn[] }`.
   - `deep_research` — start `DeepResearchWorkflow` (also forced by `mode: "deep"`).
4. `delegate`: validate plan as a DAG (no cycles, known agents, ≤4). Insert `tasks` rows, send ready subtasks to `agent-tasks`, broadcast `plan` event, schedule a 90 s run-timeout via `this.schedule`.
5. Queue consumer: `getAgentByName(env.<Specialist>, userId).runTask(envelope)` → result → `getAgentByName(env.OrchestratorAgent, instance).onSubtaskResult(result)`. `ack()` on success, `retry({ delaySeconds })` on error.
6. `onSubtaskResult`: ignore unknown or already-completed task IDs, update state, broadcast `subtask` event, dispatch newly unblocked subtasks with upstream results attached as context.
7. All subtasks settled (completed / failed / timed out) → `SummarizerAgent.synthesize()` returns a `ReadableStream` → orchestrator relays `token` events → `final` event → message saved.
8. `ctx.waitUntil`: summarizer distils ≤3 durable facts → embedded → Vectorize `kind=memory`.

### 4.2 Document upload

`POST /api/documents` (multipart, ≤10 MB, txt/md/pdf/docx/html) → R2 `docs/<userId>/<docId>/<filename>` → D1 `documents` row (`queued`) → `IngestDocumentWorkflow` instance → `GET /api/documents/:id` for status; WebSocket `document` event when ready.

### 4.3 WebSocket events (server → client)

`plan`, `subtask` (status: queued | running | completed | failed | timed_out), `research_progress`, `token`, `final`, `document`, `error`. All carry `runId` and `traceId`.

## 5. Storage

### D1 (`edgemind-db`)

- `users(id, kind['guest'|'key'], created_at)`
- `api_keys(id, user_id, name, key_hash, created_at, last_used_at, revoked_at)`
- `conversations(id, user_id, title, created_at, updated_at)`
- `tasks(id, run_id, conversation_id, user_id, agent, input, status, error, attempts, created_at, completed_at)`
- `documents(id, user_id, filename, mime, size, r2_key, status, chunk_count, error, created_at)`
- `chunks(id, document_id, user_id, idx, text)` — id equals the Vectorize vector id
- `usage(id, user_id, conversation_id, agent, provider, model, input_tokens, output_tokens, cost_usd, cached, latency_ms, created_at)`
- `audit_log(id, user_id, action, target, meta_json, ip, created_at)`

Indexes on `user_id` + `created_at` where queried by user and day.

### Vectorize (`edgemind-index`)

768 dimensions, cosine. Namespace = userId. Metadata index on `kind` (`doc` | `memory`) and `documentId`.

### R2 (`edgemind-files`)

`docs/<userId>/<docId>/<filename>`, `reports/<userId>/<runId>.md`.

### KV (`EDGEMIND_KV`)

- `config:models` — per-agent model routing JSON.
- `config:limits` — budgets and rate limits.
- `apikey:<sha256>` — user lookup cache, TTL 300 s.

### Durable Object SQLite

- Orchestrator: `messages`, `runs`, `subtasks`.
- Specialists: `task_log`.

## 6. Auth, rate limiting, cost control

- **Guest sessions:** `POST /api/session` creates a `users` row (`guest`) and returns an HS256 JWT (`sub`, `kind`, `exp` = 24 h) signed with the `JWT_SECRET` secret via Web Crypto. Limited per IP with the Workers Rate Limiting binding.
- **API keys:** `Authorization: Bearer em_<random>`. Stored as SHA-256. Issued by `POST /api/admin/keys` guarded by the `ADMIN_TOKEN` secret; plaintext returned once.
- **WebSocket auth:** token in `?token=` query (browsers cannot set WS headers), verified in `routeAgentRequest`'s `onBeforeConnect` / `onBeforeRequest`. Instance name prefix must equal the token's `sub`. Requests for any agent other than `orchestrator-agent` are rejected.
- **Rate limits:** per user messages/minute and per IP session creation (Rate Limiting binding); AI Gateway rate limit as a backstop.
- **Budget:** daily token budget per user kind (guest default 20,000 tokens), configurable in `config:limits`, enforced before each run.
- **Cost visibility:** `GET /api/usage` (today + last 7 days, per agent/model), AI Gateway analytics.

## 7. Observability

- Workers Logs enabled (`observability.enabled: true`).
- Structured JSON logger with `traceId` created per request and carried in queue messages, workflow params, and WebSocket events.
- D1 `audit_log`: session creation, key issue/revoke, uploads, run start/finish.
- `GET /api/health` probes each binding.

## 8. Error handling

- Hono error middleware → `{ error: { code, message } }`, zod validation on all inputs.
- Planner output fails validation → one repair retry → fall back to `direct`.
- Run timeout (90 s alarm) → pending subtasks marked `timed_out`, synthesis proceeds with partial results.
- Queue retries (3, backoff) then DLQ.
- Workflow steps declare retry policies; bad input raises `NonRetryableError`.
- Late or duplicate results are dropped by task ID.
- LLM provider failure → AI Gateway fallback; total failure → `error` event, run marked failed.

## 9. Testing

- Vitest with `@cloudflare/vitest-pool-workers` (workerd, local D1/KV/R2/DO/Queues).
- `LLMClient` and vector store behind interfaces; fakes in tests.
- Unit: plan validation + DAG scheduling, chunker, JWT sign/verify, API key hashing, cost estimate, event shapes.
- Integration: API routes (session, keys, upload, usage, health), orchestrator end-to-end run with fake LLM (delegate path, failure path, timeout path), queue consumer idempotency.
- `scripts/smoke.ts` against the deployed URL.

## 10. Repository layout

```
edge mind/
  src/
    index.ts                # Worker entry: Hono app, queue(), exports
    api/                    # Hono routes
    agents/                 # Orchestrator, specialists, base class
    workflows/              # IngestDocument, DeepResearch
    llm/                    # LLMClient, gateway impl, prompts, models
    memory/                 # vector store, chunker, embeddings
    auth/                   # jwt, api keys, middleware
    lib/                    # logger, errors, ids, budget, types
  public/                   # chat UI (HTML/CSS/JS)
  migrations/               # D1 SQL migrations
  test/
  scripts/setup.sh          # provisions D1, KV, R2, Vectorize, Queues
  scripts/smoke.ts
  wrangler.jsonc
  README.md
  .github/workflows/ci.yml
```
