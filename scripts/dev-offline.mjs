// Runs `wrangler dev` fully locally with no Cloudflare account: drops the AI and
// Vectorize bindings (remote-only) and sets EDGEMIND_OFFLINE so the app uses its
// deterministic model stand-in and D1-backed vector search.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
delete config.ai;
delete config.vectorize;
delete config.$schema;
config.vars = { ...config.vars, EDGEMIND_OFFLINE: "1", ENVIRONMENT: "offline" };
writeFileSync(".wrangler.offline.json", JSON.stringify(config, null, 2));

const child = spawn("npx", ["wrangler", "dev", "-c", ".wrangler.offline.json", ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
