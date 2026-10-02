/**
 * Runtime configuration stored in KV so models and limits can change without a
 * deploy:  wrangler kv key put --binding KV config:models '{"planner":"..."}'
 * Values in KV are merged over the defaults below.
 */
export interface ModelConfig {
  planner: string;
  direct: string;
  research: string;
  rag: string;
  code: string;
  summarizer: string;
  /** Second Workers AI model tried when the primary fails. */
  fallback: string;
  embedding: string;
  /** Used only when ANTHROPIC_API_KEY is set. */
  anthropic: string;
  /** Used only when OPENAI_API_KEY is set. */
  openai: string;
}

export interface LimitsConfig {
  guestDailyTokens: number;
  keyDailyTokens: number;
  maxSubtasks: number;
  runTimeoutSeconds: number;
  deepResearchRounds: number;
  maxUploadBytes: number;
}

export interface AppConfig {
  models: ModelConfig;
  limits: LimitsConfig;
}

/** Defaults use models that are available on the Workers Free plan (2026-10). */
export const DEFAULT_CONFIG: AppConfig = {
  models: {
    planner: "@cf/zai-org/glm-4.7-flash",
    direct: "@cf/zai-org/glm-4.7-flash",
    research: "@cf/zai-org/glm-4.7-flash",
    rag: "@cf/zai-org/glm-4.7-flash",
    code: "@cf/zai-org/glm-4.7-flash",
    summarizer: "@cf/google/gemma-4-26b-a4b-it",
    fallback: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    embedding: "@cf/baai/bge-base-en-v1.5",
    anthropic: "claude-opus-5-5",
    openai: "gpt-5-mini",
  },
  limits: {
    guestDailyTokens: 20_000,
    keyDailyTokens: 200_000,
    maxSubtasks: 4,
    runTimeoutSeconds: 90,
    deepResearchRounds: 3,
    maxUploadBytes: 10 * 1024 * 1024,
  },
};

export const EMBEDDING_DIMENSIONS = 768;

const CACHE_MS = 60_000;
let cached: { value: AppConfig; expires: number } | undefined;

async function readJson<T>(kv: KVNamespace, key: string): Promise<Partial<T>> {
  try {
    return ((await kv.get<Partial<T>>(key, "json")) ?? {}) as Partial<T>;
  } catch {
    return {};
  }
}

export async function getConfig(env: Env): Promise<AppConfig> {
  if (cached && cached.expires > Date.now()) return cached.value;
  const [models, limits] = await Promise.all([
    readJson<ModelConfig>(env.KV, "config:models"),
    readJson<LimitsConfig>(env.KV, "config:limits"),
  ]);
  const value: AppConfig = {
    models: { ...DEFAULT_CONFIG.models, ...models },
    limits: { ...DEFAULT_CONFIG.limits, ...limits },
  };
  cached = { value, expires: Date.now() + CACHE_MS };
  return value;
}

/** For tests. */
export function clearConfigCache(): void {
  cached = undefined;
}

/** Offline mode swaps Workers AI and Vectorize for local fakes (tests, `npm run dev:offline`). */
export function isOffline(env: Env): boolean {
  const flag = (env as unknown as { EDGEMIND_OFFLINE?: string }).EDGEMIND_OFFLINE;
  return flag === "1" || flag === "true";
}

/** Optional secrets are typed as strings by `wrangler types` but may be unset. */
export function secret(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}
