// Backfill agent_kind for guardrail-blocked 'open' decisions that were
// inserted before the bugfix. They were defaulting to 'strategic' but
// many were actually attempted by the tactical agent. Heuristic: an
// 'open' decision row 'skipped_guardrail' that has no trade attached and
// references the tactical universe (SOL/AVAX/DOGE/BNB/LINK) AND the
// reasoning mentions "15m" — that's tactical.
//
// We are conservative: only flip rows where evidence is strong.
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

function loadEnv(p) {
  const o = {};
  for (const l of readFileSync(p, "utf8").split("\n")) {
    const m = l.match(/^([A-Z_a-z][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    o[m[1]] = v;
  }
  return o;
}
const e = loadEnv(new URL("../.env.local", import.meta.url).pathname);
const url = e.trading_dashboard_DATABASE_URL || e.trading_dashboard_POSTGRES_URL;
const sql = neon(url);

// Tactical universe symbols
const TACTICAL = new Set(["SOL", "AVAX", "DOGE", "BNB", "LINK"]);

const rows = await sql`
  SELECT id, asset, agent_kind, decision_type, outcome_status, reasoning
    FROM agent_decisions
   WHERE decision_type = 'open'
     AND outcome_status IN ('skipped_guardrail', 'failed')
     AND agent_kind = 'strategic'
   ORDER BY ts DESC
`;
let updated = 0;
for (const r of rows) {
  const isTacticalAsset = TACTICAL.has((r.asset || "").toUpperCase());
  const mentions15m = /\b15m\b|\bfifteenminutes\b/i.test(r.reasoning || "");
  if (isTacticalAsset && mentions15m) {
    await sql`UPDATE agent_decisions SET agent_kind = 'tactical' WHERE id = ${r.id}`;
    updated++;
    console.log(`  flipped ${r.id} (${r.asset}) → tactical`);
  }
}
console.log(`\nDone. Inspected ${rows.length} skipped/failed open decisions, flipped ${updated} → tactical.`);
