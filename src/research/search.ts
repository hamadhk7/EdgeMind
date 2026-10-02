import { isOffline, secret } from "../lib/config";
import type { Source } from "../lib/types";

const USER_AGENT = "EdgeMind/0.1 (multi-agent demo on Cloudflare Workers)";
const SNIPPET_CHARS = 1200;

/**
 * Web search used by the research agent and the deep research workflow.
 * Tavily when TAVILY_API_KEY is set, otherwise Wikipedia (free, no key).
 */
export async function webSearch(env: Env, query: string, limit = 5): Promise<Source[]> {
  if (isOffline(env)) {
    return [
      { title: `Offline result for "${query}"`, url: "https://example.com/offline", snippet: `Background on ${query}.` },
    ];
  }
  const tavilyKey = secret(env.TAVILY_API_KEY);
  return tavilyKey ? tavilySearch(tavilyKey, query, limit) : wikipediaSearch(query, limit);
}

async function tavilySearch(apiKey: string, query: string, limit: number): Promise<Source[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
  return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content.slice(0, SNIPPET_CHARS) }));
}

async function wikipediaSearch(query: string, limit: number): Promise<Source[]> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(limit),
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exlimit: String(limit),
    inprop: "url",
  }).toString();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Wikipedia search failed: ${res.status}`);
  const body = (await res.json()) as {
    query?: { pages?: Array<{ title: string; fullurl?: string; extract?: string; index?: number }> };
  };
  return (body.query?.pages ?? [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({ title: p.title, url: p.fullurl, snippet: (p.extract ?? "").slice(0, SNIPPET_CHARS) }));
}
