// Neon Postgres serverless client.
// Used for hot agent state: decisions, trades, memory, guardrail tracking.
// Schema lives in /db/migrations/.
import { neon, neonConfig } from "@neondatabase/serverless";

// Vercel + Neon: HTTP-only fetcher (works in serverless without WebSocket).
// Setting fetchConnectionCache=true reuses the connection across invocations
// in the same Lambda runtime, reducing latency.
neonConfig.fetchConnectionCache = true;

let _sql: ReturnType<typeof neon> | null = null;

export function db(): ReturnType<typeof neon> {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Missing DATABASE_URL — Neon integration not configured. " +
        "Add the Neon Postgres integration to this project in Vercel.",
    );
  }
  _sql = neon(url);
  return _sql;
}

// ────────────────────────────────────────────────────────────────────
// Domain types — mirror schema in db/migrations/0001_init.sql
// ────────────────────────────────────────────────────────────────────

export type AgentEnvironment = "real" | "paper";

export interface AgentDecisionRow {
  id: string;
  ts: string;
  environment: AgentEnvironment;
  decision_type: "open" | "close" | "modify" | "hold" | "scan_only";
  asset: string | null;
  reasoning: string;
  hvf_score: number | null;
  conviction: "high" | "medium" | "low" | null;
  outcome_status: "executed" | "skipped_guardrail" | "failed" | "pending";
  guardrail_violation: string | null;
  trade_id: string | null;
  raw_context: unknown; // JSON
}

export interface TradeRow {
  id: string;
  decision_id: string | null;
  environment: AgentEnvironment;
  etoro_position_id: string | null;
  asset: string;
  instrument_id: number;
  side: "long" | "short";
  entry_price: number;
  size_usd: number;
  units: number | null;
  stop_loss: number;
  take_profit: number;
  leverage: number;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  pnl_usd: number | null;
  r_multiple: number | null;
  exit_reason: "stop" | "target" | "manual_close" | "agent_close" | "expired" | null;
  status: "open" | "closed" | "cancelled";
}

export interface AgentMemoryRow {
  id: string;
  ts: string;
  category: "lesson" | "thesis" | "instrument_note" | "self_review";
  asset: string | null;
  content: string;
  importance: number; // 1-10
  related_trade_id: string | null;
}

export interface GuardrailStateRow {
  environment: AgentEnvironment;
  daily_realized_pnl: number;
  daily_reset_at: string;
  consecutive_losses: number;
  cooldown_until: string | null;
  last_entry_at: string | null;
  open_position_count: number;
}
