#!/usr/bin/env bash
# Provisions every Cloudflare resource EdgeMind needs, writes their ids into
# wrangler.jsonc, applies D1 migrations, deploys, and sets secrets.
# Safe to re-run: existing resources are reused.
#
# Requires: `npx wrangler login` (or CLOUDFLARE_API_TOKEN), Node 20+, openssl.
set -euo pipefail
cd "$(dirname "$0")/.."

WR="npx wrangler"
step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }

step "Checking Cloudflare login"
$WR whoami >/dev/null || { echo "Run 'npx wrangler login' first."; exit 1; }
ok "logged in"

step "D1 database"
$WR d1 create edgemind-db >/dev/null 2>&1 || true
D1_ID=$($WR d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=l.find(x=>x.name==="edgemind-db");if(!d)process.exit(1);console.log(d.uuid)')
ok "edgemind-db ($D1_ID)"

step "KV namespace"
$WR kv namespace create edgemind-kv >/dev/null 2>&1 || true
KV_ID=$($WR kv namespace list | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));const n=l.find(x=>x.title==="edgemind-kv"||x.title.endsWith("edgemind-kv"));if(!n)process.exit(1);console.log(n.id)')
ok "edgemind-kv ($KV_ID)"

step "R2 bucket"
if ! $WR r2 bucket list 2>/dev/null | grep -q "name:\s*edgemind-files"; then
  if ! out=$($WR r2 bucket create edgemind-files 2>&1); then
    echo "$out" | grep -E "ERROR|code:" || echo "$out"
    echo "  R2 is not enabled on this account. Enable it in the dashboard (R2 > Overview), then re-run this script."
    exit 1
  fi
fi
ok "edgemind-files"

step "Vectorize index"
$WR vectorize create edgemind-index --dimensions=768 --metric=cosine >/dev/null 2>&1 || true
$WR vectorize create-metadata-index edgemind-index --property-name=kind --type=string >/dev/null 2>&1 || true
$WR vectorize create-metadata-index edgemind-index --property-name=documentId --type=string >/dev/null 2>&1 || true
ok "edgemind-index (768 dims, cosine, metadata indexes: kind, documentId)"

step "Queues"
$WR queues create edgemind-agent-tasks >/dev/null 2>&1 || true
$WR queues create edgemind-agent-tasks-dlq >/dev/null 2>&1 || true
ok "edgemind-agent-tasks + edgemind-agent-tasks-dlq"

step "Writing resource ids into wrangler.jsonc"
D1_ID="$D1_ID" KV_ID="$KV_ID" node -e '
const fs = require("fs");
let s = fs.readFileSync("wrangler.jsonc", "utf8");
s = s.replace(/("database_id":\s*")[^"]*(")/, `$1${process.env.D1_ID}$2`);
s = s.replace(/("binding":\s*"KV",\s*"id":\s*")[^"]*(")/, `$1${process.env.KV_ID}$2`);
fs.writeFileSync("wrangler.jsonc", s);'
ok "updated"

step "Applying D1 migrations"
$WR d1 migrations apply edgemind-db --remote
ok "schema ready"

step "Deploying"
$WR deploy
ok "deployed"

step "Secrets"
if [ ! -f .secrets.json ]; then
  JWT_SECRET=$(openssl rand -hex 32)
  ADMIN_TOKEN=$(openssl rand -hex 24)
  printf '{"JWT_SECRET":"%s","ADMIN_TOKEN":"%s"}\n' "$JWT_SECRET" "$ADMIN_TOKEN" > .secrets.json
  chmod 600 .secrets.json
fi
$WR secret bulk .secrets.json
ok "JWT_SECRET and ADMIN_TOKEN set (kept in .secrets.json, which is gitignored)"

cat <<'EOF'

Done. Optional extras:
  npx wrangler secret put ANTHROPIC_API_KEY   # Claude fallback via AI Gateway
  npx wrangler secret put OPENAI_API_KEY      # OpenAI fallback via AI Gateway
  npx wrangler secret put TAVILY_API_KEY      # better web search than Wikipedia

Verify with:  npm run smoke -- https://<your-worker>.workers.dev
EOF
