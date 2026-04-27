// Quick status check — recent agent_decisions, open trades, guardrail state.
// Usage:  node scripts/agent-status.mjs [limit]
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

const limit = parseInt(process.argv[2] || "10", 10);

const decisions = await sql`
  SELECT to_char(ts, 'HH24:MI:SS') as t, environment as env, agent_kind as kind, decision_type as type,
         asset, hvf_score as hvf, outcome_status as out, guardrail_violation as gv,
         left(reasoning, 110) as r, length(reasoning) as len
    FROM agent_decisions
   WHERE ts > now() - interval '6 hours'
   ORDER BY ts DESC LIMIT ${limit}
`;
console.log(`\n=== last ${decisions.length} decisions ===`);
for (const d of decisions) {
  console.log(`${d.t} ${d.env.padEnd(5)} ${(d.kind||'?').padEnd(9)} ${d.type.padEnd(9)} ${(d.asset||'-').padEnd(5)} hvf=${d.hvf||'-'} ${d.out}${d.gv?' BLK='+d.gv:''}`);
  console.log(`   ${d.r}${d.len > 110 ? '...['+d.len+']' : ''}`);
}

const trades = await sql`
  SELECT id, environment, asset, side, agent_kind, status,
         entry_price, size_usd, stop_loss, take_profit,
         to_char(opened_at, 'MM-DD HH24:MI') as opened,
         to_char(closed_at, 'MM-DD HH24:MI') as closed,
         exit_reason, exit_price, pnl_usd, etoro_position_id
    FROM trades
   WHERE opened_at > now() - interval '24 hours'
   ORDER BY opened_at DESC LIMIT 10
`;
console.log(`\n=== last ${trades.length} trades (24h) ===`);
for (const t of trades) {
  console.log(`${t.opened} ${t.environment} ${t.agent_kind || '?'} ${t.asset.padEnd(5)} ${t.side.padEnd(5)} entry=${t.entry_price} size=$${t.size_usd} status=${t.status} pos=${t.etoro_position_id || '-'}${t.closed ? ' closed='+t.closed+' reason='+t.exit_reason+' pnl=$'+(t.pnl_usd||'?') : ''}`);
}

const gs = await sql`SELECT * FROM guardrail_state ORDER BY environment`;
console.log(`\n=== guardrail state ===`);
for (const g of gs) {
  console.log(`${g.environment}: open=${g.open_position_count}, dailyPnL=$${g.daily_realized_pnl}, conLosses=${g.consecutive_losses}, cooldown=${g.cooldown_until || 'none'}, lastEntry=${g.last_entry_at || 'never'}`);
}

// Any new dirty rows since the fix? (sanity-check)
const dirty = await sql`SELECT COUNT(*)::int n FROM agent_decisions WHERE reasoning LIKE '%<parameter%'`;
console.log(`\n=== sanitizer health ===`);
console.log(`dirty rows in agent_decisions: ${dirty[0].n}`);
