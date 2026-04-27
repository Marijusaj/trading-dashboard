// One-shot: sanitize Haiku XML-tag bleed in agent_decisions + agent_memory.
// Mirrors src/lib/agent/execute.ts sanitizeReasoning().
//
// Usage:  node scripts/clean-reasoning.mjs
//
// Reads DB URL from .env.local (run `vercel env pull` first).
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function sanitize(input) {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/["']?,?\s*\n?\s*<parameter\b[^>]*>[\s\S]*$/i, "");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = s.replace(/[\\"',\s]+$/g, "");
  return s.trim();
}

const env = loadEnv(new URL("../.env.local", import.meta.url).pathname);
const url =
  env.trading_dashboard_DATABASE_URL ||
  env.trading_dashboard_POSTGRES_URL ||
  env.DATABASE_URL ||
  env.POSTGRES_URL;
if (!url) {
  console.error("No DB URL in .env.local");
  process.exit(1);
}

const sql = neon(url);

async function main() {
  // Find dirty rows — Postgres POSIX regex doesn't support \b, use LIKE
  const decRows = await sql`
    SELECT id, reasoning FROM agent_decisions
     WHERE reasoning LIKE '%<parameter%' OR reasoning LIKE '%</parameter%'
     ORDER BY ts DESC LIMIT 500
  `;
  let decUpdated = 0;
  for (const r of decRows) {
    const cleaned = sanitize(r.reasoning);
    if (cleaned !== r.reasoning) {
      await sql`UPDATE agent_decisions SET reasoning = ${cleaned} WHERE id = ${r.id}`;
      decUpdated++;
      console.log(`  decision ${r.id}: trimmed ${r.reasoning.length - cleaned.length} chars`);
    }
  }

  const memRows = await sql`
    SELECT id, content FROM agent_memory
     WHERE content LIKE '%<parameter%' OR content LIKE '%</parameter%'
     ORDER BY ts DESC LIMIT 500
  `;
  let memUpdated = 0;
  for (const r of memRows) {
    const cleaned = sanitize(r.content);
    if (cleaned !== r.content) {
      await sql`UPDATE agent_memory SET content = ${cleaned} WHERE id = ${r.id}`;
      memUpdated++;
      console.log(`  memory   ${r.id}: trimmed ${r.content.length - cleaned.length} chars`);
    }
  }

  console.log(`\nDone. decisions: ${decUpdated}/${decRows.length} updated. memory: ${memUpdated}/${memRows.length} updated.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
