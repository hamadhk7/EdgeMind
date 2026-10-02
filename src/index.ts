import { routeAgentRequest } from "agents";
import { createApp } from "./api/app";
import { extractToken, parseOrchestratorName, resolvePrincipal } from "./auth/principal";
import type { QueueMessage } from "./lib/types";
import { handleQueue } from "./queue/consumer";

export { OrchestratorAgent } from "./agents/orchestrator";
export { ResearchAgent } from "./agents/research";
export { RagAgent } from "./agents/rag";
export { CodeAgent } from "./agents/code";
export { SummarizerAgent } from "./agents/summarizer";
export { IngestDocumentWorkflow } from "./workflows/ingest";
export { DeepResearchWorkflow } from "./workflows/deepResearch";

const app = createApp();

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Gate for `/agents/:agent/:name`. Only the orchestrator is public, and only to
 * the user whose id prefixes the instance name. The token is stripped from the
 * forwarded URL so it never reaches logs downstream.
 */
async function authorizeAgentRequest(
  request: Request,
  env: Env,
  route: { className: string; name: string },
): Promise<Response | Request> {
  if (route.className !== "OrchestratorAgent") return jsonError(404, "not_found", "Unknown agent");
  const principal = await resolvePrincipal(env, extractToken(request));
  if (!principal) return jsonError(401, "unauthorized", "Missing or invalid token");
  const target = parseOrchestratorName(route.name);
  if (!target || target.userId !== principal.userId) {
    return jsonError(403, "forbidden", "This conversation belongs to another user");
  }
  const url = new URL(request.url);
  url.searchParams.delete("token");
  return new Request(url, request);
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/agents/")) {
      const response = await routeAgentRequest(request, env, {
        onBeforeConnect: (req, route) => authorizeAgentRequest(req, env, route),
        onBeforeRequest: (req, route) => authorizeAgentRequest(req, env, route),
      });
      return response ?? jsonError(404, "not_found", "Unknown agent route");
    }
    return app.fetch(request, env, ctx);
  },

  async queue(batch, env) {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
