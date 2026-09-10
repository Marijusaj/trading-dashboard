// HVF score history — what have the scores actually been doing, and how
// far from the entry thresholds?
//
// Answers the question "the agent runs every day but never trades": it
// shows the distribution of top-candidate HVF scores per scan against the
// per-env threshold, so a recalibration can be anchored to real history
// rather than to one day of live candles.
//
// Usage:  node scripts/hvf-history.mjs [days]        (default 90)
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

function loadEnv(p) {
  const o = {};
  try {
    for (const l of readFileSync(p, "utf8").split("\n")) {
      const m = l.match(/^([A-Z_a-z][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      o[m[1]] = v;
    }
  } catch {
    /* fall through to process.env */
  }
  return o;
}

const e = loadEnv(new URL("../.env.local", import.meta.url).pathname);
// Same candidate list as src/lib/neon.ts, .env.local first then real env.
const CANDIDATES = [
  "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL",
  "trading_dashboard_DATABASE_URL", "trading_dashboard_POSTGRES_URL",
  "trading_dashboard_POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING",
  "trading_dashboard_DATABASE_URL_UNPOOLED",
  "trading_dashboard_POSTGRES_URL_NON_POOLING",
];
const url = CANDIDATES.map((n) => e[n] || process.env[n]).find((v) => v && v.length);
if (!url) {
  console.error("No Neon URL found in .env.local or the environment. Looked for:\n  " + CANDIDATES.join("\n  "));
  process.exit(1);
}
const sql = neon(url);
const days = parseInt(process.argv[2] || "90", 10);

// Entry thresholds as they stand in the prompts today. Keep in sync with
// prompt.ts (strategic) and tactical-prompt.ts (tactical).
const THRESHOLDS = {
  "paper/strategic": 50,   // any strategy's score > 50
  "real/strategic":  68,   // HVF only
  "paper/tactical":  60,
  "real/tactical":   72,
};

const pct = (arr, p) => {
  if (!arr.length) return null;
  const i = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[i];
};
const fmt = (v, d = 1) => (v === null || v === undefined ? "  -  " : Number(v).toFixed(d));

console.log(`\n${"=".repeat(72)}\nHVF SCORE HISTORY — last ${days} days\n${"=".repeat(72)}`);

// ── 1. Is it actually running? ────────────────────────────────────────
const cadence = await sql`
  SELECT environment AS env, agent_kind AS kind,
         count(*)::int                                   AS decisions,
         count(DISTINCT date_trunc('day', ts))::int      AS active_days,
         to_char(max(ts), 'YYYY-MM-DD HH24:MI')          AS last_seen
    FROM agent_decisions
   WHERE ts > now() - (${String(days)} || ' days')::interval
   GROUP BY 1, 2 ORDER BY 1, 2
`;
console.log(`\n── Scan cadence ──`);
console.log("env    kind       decisions  active_days  last_seen");
for (const r of cadence) {
  console.log(
    `${r.env.padEnd(6)} ${(r.kind || "?").padEnd(10)} ${String(r.decisions).padStart(9)} ` +
    `${String(r.active_days).padStart(12)}  ${r.last_seen}`,
  );
}

// ── 2. Score distribution vs threshold ────────────────────────────────
const rows = await sql`
  SELECT environment AS env, agent_kind AS kind, hvf_score AS score
    FROM agent_decisions
   WHERE ts > now() - (${String(days)} || ' days')::interval
     AND hvf_score IS NOT NULL
`;
const buckets = new Map();
for (const r of rows) {
  const k = `${r.env}/${r.kind || "strategic"}`;
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(Number(r.score));
}
console.log(`\n── Top-candidate score per scan vs entry threshold ──`);
console.log("env/kind           n   median     p90      max   bar   headroom   cleared");
for (const [k, raw] of [...buckets].sort()) {
  const s = raw.slice().sort((a, b) => a - b);
  const bar = THRESHOLDS[k];
  const max = s[s.length - 1];
  const cleared = bar === undefined ? null : s.filter((v) => v >= bar).length;
  const headroom = bar === undefined ? null : max - bar;
  console.log(
    `${k.padEnd(17)} ${String(s.length).padStart(4)} ${fmt(pct(s, 50)).padStart(7)} ` +
    `${fmt(pct(s, 90)).padStart(7)} ${fmt(max).padStart(8)} ${String(bar ?? "-").padStart(5)} ` +
    `${(headroom === null ? "  -  " : (headroom >= 0 ? "+" : "") + fmt(headroom)).padStart(10)} ` +
    `${cleared === null ? "  -" : String(cleared).padStart(5)}`,
  );
}
console.log(`\n  headroom = best score ever observed minus the threshold.`);
console.log(`  A negative headroom means the bar was NEVER reachable in this window.`);

// ── 3. What did it decide? ────────────────────────────────────────────
const types = await sql`
  SELECT environment AS env, agent_kind AS kind, decision_type AS type,
         outcome_status AS outcome, count(*)::int AS n
    FROM agent_decisions
   WHERE ts > now() - (${String(days)} || ' days')::interval
   GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
`;
console.log(`\n── Decision outcomes ──`);
console.log("env    kind       type       outcome              n");
for (const r of types) {
  console.log(
    `${r.env.padEnd(6)} ${(r.kind || "?").padEnd(10)} ${r.type.padEnd(10)} ` +
    `${r.outcome.padEnd(18)} ${String(r.n).padStart(5)}`,
  );
}

// ── 4. Where entries died ─────────────────────────────────────────────
const blocks = await sql`
  SELECT environment AS env, agent_kind AS kind,
         guardrail_violation AS violation, count(*)::int AS n
    FROM agent_decisions
   WHERE ts > now() - (${String(days)} || ' days')::interval
     AND guardrail_violation IS NOT NULL
   GROUP BY 1, 2, 3 ORDER BY 4 DESC
`;
console.log(`\n── Guardrail blocks (entries the agent DID attempt) ──`);
if (!blocks.length) {
  console.log("  none — no entry ever got as far as the guardrail check.");
} else {
  for (const r of blocks) {
    console.log(`${r.env.padEnd(6)} ${(r.kind || "?").padEnd(10)} ${r.violation.padEnd(30)} ${String(r.n).padStart(5)}`);
  }
}

// ── 5. Actual trades ──────────────────────────────────────────────────
const trades = await sql`
  SELECT environment AS env, agent_kind AS kind, strategy, status,
         count(*)::int AS n, round(sum(pnl_usd)::numeric, 2) AS pnl
    FROM trades
   WHERE opened_at > now() - (${String(days)} || ' days')::interval
   GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
`;
console.log(`\n── Trades opened in window ──`);
if (!trades.length) {
  console.log("  none.");
} else {
  console.log("env    kind       strategy      status      n      pnl");
  for (const r of trades) {
    console.log(
      `${r.env.padEnd(6)} ${(r.kind || "?").padEnd(10)} ${(r.strategy || "-").padEnd(13)} ` +
      `${r.status.padEnd(10)} ${String(r.n).padStart(3)} ${String(r.pnl ?? "-").padStart(8)}`,
    );
  }
}

// ── 6. Drought ────────────────────────────────────────────────────────
const last = await sql`
  SELECT environment AS env, agent_kind AS kind,
         to_char(max(opened_at), 'YYYY-MM-DD HH24:MI')                     AS last_entry,
         round(extract(epoch FROM now() - max(opened_at)) / 86400.0, 1)    AS days_ago
    FROM trades
   GROUP BY 1, 2 ORDER BY 1, 2
`;
console.log(`\n── Last actual entry (all time) ──`);
if (!last.length) {
  console.log("  no trade has EVER been opened.");
} else {
  for (const r of last) {
    console.log(`${r.env.padEnd(6)} ${(r.kind || "?").padEnd(10)} ${r.last_entry}  (${r.days_ago}d ago)`);
  }
}
console.log("");
