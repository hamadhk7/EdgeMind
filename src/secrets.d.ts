// Secrets are set with `wrangler secret put` and never live in wrangler.jsonc, so
// `wrangler types` only sees them when a local .dev.vars exists. Declaring them here
// keeps type checking identical in CI and on a fresh clone.
// Optional ones may be unset at runtime; read them through `secret()` in lib/config.ts.
interface EdgeMindSecrets {
  JWT_SECRET: string;
  ADMIN_TOKEN: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  TAVILY_API_KEY: string;
}

interface Env extends EdgeMindSecrets {}

declare namespace Cloudflare {
  interface Env extends EdgeMindSecrets {}
}
