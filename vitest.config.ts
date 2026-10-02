import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests run fully locally: offline mode swaps Workers AI and Vectorize for fakes.
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            EDGEMIND_OFFLINE: "1",
            JWT_SECRET: "test-jwt-secret",
            ADMIN_TOKEN: "test-admin-token",
            OPENAI_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            TAVILY_API_KEY: "",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      testTimeout: 30_000,
    },
  };
});
