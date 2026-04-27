// Reconciler — runs at the start of each agent loop.
//
// Two responsibilities:
//
// 1. Open orders we placed but never resolved to a position
//    (status=open, etoro_position_id is null/empty):
//       - If we have an etoro_order_id: getOrderInfo, follow statusID
//           1 -> mark trade open with positionID
//           2 -> mark cancelled
//           3 -> mark cancelled (rejected)
//           4 -> mark cancelled (partially executed = treat as failed)
//          11 -> still pending (market closed) — leave as-is
//       - If no etoro_order_id (legacy entries from before the fix):
//           24h+ old: mark abandoned. <24h: leave for next pass.
//
// 2. Open trades we know about (etoro_position_id present): verify
//    they're still in eToro's positions[]. If not, the position was
//    closed (TP/SL, manual, expired). Mark trade closed with best-
//    effort exit data.
//
// Returns a summary the agent loop logs into the next decision.
import { db } from "@/lib/neon";
import { etoro } from "@/lib/etoro/client";
import { recordClose, recordEntry } from "./guardrails";
import type { AgentEnvironment } from "@/lib/neon";

interface PendingTradeRow {
  id: string;
  environment: AgentEnvironment;
  etoro_order_id: string | null;
  etoro_position_id: string | null;
  asset: string;
  instrument_id: number;
  side: "long" | "short";
  entry_price: number | string;
  size_usd: number | string;
  stop_loss: number | string;
  take_profit: number | string;
  opened_at: string;
}

export interface ReconcileSummary {
  environment: AgentEnvironment;
  scanned: number;
  resolved_executed: string[];
  resolved_cancelled: string[];
  closed_externally: string[];
  abandoned: string[];
  still_pending: string[];
  errors: string[];
}

export async function reconcileEnv(env: AgentEnvironment): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    environment: env,
    scanned: 0,
    resolved_executed: [],
    resolved_cancelled: [],
    closed_externally: [],
    abandoned: [],
    still_pending: [],
    errors: [],
  };

  const sql = db();

  // 1. Pull all open trades for this environment
  const trades = (await sql`
    SELECT id, environment, etoro_order_id, etoro_position_id, asset, instrument_id,
           side, entry_price, size_usd, stop_loss, take_profit, opened_at
      FROM trades
     WHERE environment = ${env} AND status = 'open'
  `) as unknown as PendingTradeRow[];
  summary.scanned = trades.length;

  if (trades.length === 0) return summary;

  // 2. Snapshot eToro portfolio once for cross-checks
  let portfolioPositionIds = new Set<string>();
  try {
    const portfolio = await etoro.getPortfolio(env);
    portfolioPositionIds = new Set(portfolio.positions.map((p) => String(p.positionID)));
  } catch (e) {
    summary.errors.push(`portfolio fetch failed: ${e instanceof Error ? e.message : e}`);
  }

  for (const t of trades) {
    try {
      const hasPosition = !!t.etoro_position_id;
      const hasOrder = !!t.etoro_order_id;

      // ── Case A: trade thinks it has a position; verify it's still on eToro
      if (hasPosition) {
        if (portfolioPositionIds.has(t.etoro_position_id!)) {
          // Position still open — nothing to do
          continue;
        }
        // Position closed externally (TP/SL hit, manual close, etc.)
        await sql`
          UPDATE trades
             SET status        = 'closed',
                 closed_at     = now(),
                 exit_reason   = 'expired',
                 reconciled_at = now()
           WHERE id = ${t.id}
        `;
        // Best-effort: don't know exact exit price, leave null. PnL too.
        await recordClose(env, 0); // 0 PnL since we don't know — don't bias counters
        summary.closed_externally.push(t.id);
        continue;
      }

      // ── Case B: trade is pending (no positionID), check the order
      // Source of truth = positions[].isOpen + errorCode. statusID
      // alone is unreliable.
      if (hasOrder) {
        const info = await etoro.getOrderInfo(env, t.etoro_order_id!);
        if (info.errorCode && info.errorCode !== 0) {
          // Real rejection
          await sql`
            UPDATE trades
               SET status        = 'cancelled',
                   closed_at     = now(),
                   exit_reason   = 'expired',
                   reconciled_at = now()
             WHERE id = ${t.id}
          `;
          summary.resolved_cancelled.push(`${t.id} (errorCode ${info.errorCode}: ${info.errorMessage || ""})`);
        } else if (info.positionIsOpen && info.positionID) {
          // Position created since last check
          await sql`
            UPDATE trades
               SET etoro_position_id = ${info.positionID},
                   entry_price       = ${info.openRate ?? t.entry_price},
                   units             = ${info.units || null},
                   reconciled_at     = now()
             WHERE id = ${t.id}
          `;
          await recordEntry(env);
          summary.resolved_executed.push(t.id);
        } else if (info.statusID === 2) {
          await sql`
            UPDATE trades
               SET status        = 'cancelled',
                   closed_at     = now(),
                   exit_reason   = 'expired',
                   reconciled_at = now()
             WHERE id = ${t.id}
          `;
          summary.resolved_cancelled.push(`${t.id} (statusID=2 cancelled)`);
        } else {
          // statusID 0/11 or other ambiguous — still pending
          summary.still_pending.push(t.id);
        }
        continue;
      }

      // ── Case C: legacy / no order_id — abandon if older than 24h
      const ageHours = (Date.now() - new Date(t.opened_at).getTime()) / 3_600_000;
      if (ageHours > 24) {
        await sql`
          UPDATE trades
             SET status        = 'abandoned',
                 closed_at     = now(),
                 exit_reason   = 'expired',
                 reconciled_at = now()
           WHERE id = ${t.id}
        `;
        summary.abandoned.push(t.id);
      } else {
        summary.still_pending.push(t.id);
      }
    } catch (e) {
      summary.errors.push(`${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. Re-derive open_position_count from reality (defensive)
  const openCountRow = (await sql`
    SELECT COUNT(*)::int AS n FROM trades
     WHERE environment = ${env}
       AND status = 'open'
       AND etoro_position_id IS NOT NULL AND etoro_position_id <> ''
  `) as unknown as { n: number }[];
  const openCount = openCountRow[0]?.n ?? 0;
  await sql`
    UPDATE guardrail_state
       SET open_position_count = ${openCount}
     WHERE environment = ${env}
  `;

  return summary;
}
