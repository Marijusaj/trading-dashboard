// Dashboard data: recent agent decisions, open trades, recent closed trades.
import { NextResponse } from "next/server";
import { db } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export async function GET() {
  try {
    const sql = db();
    const [decisions, openTrades, recentClosed, memory, guardrailState] = await Promise.all([
      sql`
        SELECT id, ts, environment, decision_type, asset, reasoning,
               hvf_score, conviction, outcome_status, guardrail_violation
          FROM agent_decisions
         ORDER BY ts DESC LIMIT 20
      `,
      sql`
        SELECT id, environment, asset, side, entry_price, size_usd,
               stop_loss, take_profit, leverage, opened_at, etoro_position_id
          FROM trades
         WHERE status = 'open'
         ORDER BY opened_at DESC
      `,
      sql`
        SELECT id, environment, asset, side, entry_price, exit_price,
               size_usd, pnl_usd, r_multiple, exit_reason,
               opened_at, closed_at
          FROM trades
         WHERE status = 'closed'
         ORDER BY closed_at DESC LIMIT 10
      `,
      sql`
        SELECT id, ts, category, asset, content, importance
          FROM agent_memory
         ORDER BY importance DESC, ts DESC LIMIT 10
      `,
      sql`SELECT * FROM guardrail_state`,
    ]);

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      decisions,
      openTrades,
      recentClosed,
      memory,
      guardrailState,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
