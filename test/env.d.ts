import type { D1Migration } from "cloudflare:test";

interface TestBindings {
  TEST_MIGRATIONS: D1Migration[];
  EDGEMIND_OFFLINE: string;
}

declare global {
  // Both the global Env and Cloudflare.Env need the test-only bindings, or Agent<Env> stops matching.
  interface Env extends TestBindings {}
  namespace Cloudflare {
    interface Env extends TestBindings {}
  }
}
