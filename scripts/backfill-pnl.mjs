// Backfill exit_price/pnl_usd/r_multiple for closed trades that have
// null pnl_usd. Uses current eToro mid-rate as best-effort exit price.
// Same heuristic as the reconciler: if current price overshot SL/TP,
// snap to that level.
//
// Usage:  node scripts/backfill-pnl.mjs
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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

const apiKey = e.ETORO_PUBLIC_KEY;
const userKeys = { paper: e.ETORO_PAPER_API_KEY, real: e.ETORO_REAL_API_KEY };

async function fetchRate(env, instrumentId) {
  const userKey = userKeys[env];
  if (!userKey || !apiKey) return null;
  const url = `https://public-api.etoro.com/api/v1/market-data/instruments/rates?instrumentIds=${instrumentId}`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "x-user-key": userKey,
      "x-request-id": randomUUID(),
      "Accept": "application/json",
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const r = (data.rates || [])[0];
  if (!r) return null;
  return (Number(r.bid) + Number(r.ask)) / 2;
}

const rows = await sql`
  SELECT id, environment, asset, instrument_id, side, entry_price,
         size_usd, stop_loss, take_profit
    FROM trades
   WHERE status = 'closed' AND pnl_usd IS NULL
   ORDER BY closed_at DESC LIMIT 50
`;

console.log(`Found ${rows.length} closed trades with null PnL`);
let updated = 0;
for (const t of rows) {
  const mid = await fetchRate(t.environment, Number(t.instrument_id));
  if (mid === null) {
    console.log(`  ${t.id} ${t.asset}: no rate, skipping`);
    continue;
  }
  const sl = Number(t.stop_loss);
  const tp = Number(t.take_profit);
  const entry = Number(t.entry_price);
  let exitPrice;
  let exitReason = "expired";
  if (t.side === "long") {
    if (mid <= sl) { exitPrice = sl; exitReason = "stop"; }
    else if (mid >= tp) { exitPrice = tp; exitReason = "target"; }
    else { exitPrice = mid; }
  } else {
    if (mid >= sl) { exitPrice = sl; exitReason = "stop"; }
    else if (mid <= tp) { exitPrice = tp; exitReason = "target"; }
    else { exitPrice = mid; }
  }
  const direction = t.side === "long" ? 1 : -1;
  const pctMove = ((exitPrice - entry) / entry) * direction;
  const pnlUsd = Number(t.size_usd) * pctMove;
  const riskPerUnit = Math.abs(entry - sl);
  const moveAbs = Math.abs(exitPrice - entry);
  const rMultiple = riskPerUnit > 0 ? (moveAbs / riskPerUnit) * (pnlUsd >= 0 ? 1 : -1) : null;

  await sql`
    UPDATE trades
       SET exit_price = ${exitPrice},
           pnl_usd    = ${pnlUsd},
           r_multiple = ${rMultiple}
     WHERE id = ${t.id}
  `;
  updated++;
  console.log(`  ${t.id} ${t.asset} ${t.side}: entry=${entry} mid=${mid} guess_exit=${exitPrice.toFixed(4)} pnl=$${pnlUsd.toFixed(2)} r=${rMultiple?.toFixed(2)} (${exitReason})`);
}
console.log(`\nDone. Backfilled ${updated}/${rows.length}.`);
