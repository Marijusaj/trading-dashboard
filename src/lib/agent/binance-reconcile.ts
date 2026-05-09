// Binance reconciler — runs at the start of every Binance agent loop.
//
// For each open Binance trade, verifies the base-asset balance still
// covers the trade's units. If it doesn't (user manually sold, or trade
// got out of sync), mark the trade closed with best-effort exit data.
//
// Much simpler than eToro's reconciler because Binance spot has no
// pending orders, no position IDs, no statusID quirks — just balances.

import { db } from "@/lib/neon";
import { binance } from "@/lib/binance/client";
import { binanceSymbol } from "@/lib/binance/symbols";
import { recordClose } from "./guardrails";

export interface BinanceReconcileSummary {
  scanned: number;
  closedExternally: string[];
  errors: string[];
}

interface OpenBinanceTradeRow {
  id: string;
  asset: string;
  entry_price: string | number;
  units: string | number;
  stop_loss: string | number;
}

export async function reconcileBinance(): Promise<BinanceReconcileSummary> {
  const summary: BinanceReconcileSummary = { scanned: 0, closedExternally: [], errors: [] };
  const sql = db();

  const trades = (await sql`
    SELECT id, asset, entry_price, units, stop_loss
      FROM trades
     WHERE environment = 'binance' AND status = 'open'
  `) as unknown as OpenBinanceTradeRow[];
  summary.scanned = trades.length;
  if (trades.length === 0) return summary;

  let balances: Map<string, number>;
  try {
    const acct = await binance.account();
    balances = new Map(acct.balances.map((b) => [b.asset, b.free + b.locked]));
  } catch (e) {
    summary.errors.push(`Binance account fetch failed: ${e instanceof Error ? e.message : e}`);
    return summary;
  }

  // Group by asset to handle multiple open trades on same asset
  const expectedByAsset = new Map<string, number>();
  for (const t of trades) {
    expectedByAsset.set(t.asset, (expectedByAsset.get(t.asset) || 0) + Number(t.units));
  }

  for (const t of trades) {
    try {
      const liveBalance = balances.get(t.asset) || 0;
      const expectedTotal = expectedByAsset.get(t.asset) || 0;
      if (liveBalance < expectedTotal * 0.99) {
        // Position partially or fully missing — close this trade with best-effort exit
        const pair = binanceSymbol(t.asset);
        let exitPrice = Number(t.entry_price);
        let pnlUsd = 0;
        if (pair) {
          try {
            exitPrice = await binance.price(pair);
            pnlUsd = (exitPrice - Number(t.entry_price)) * Number(t.units);
          } catch { /* leave defaults */ }
        }
        const entry = Number(t.entry_price);
        const riskPerUnit = Math.abs(entry - Number(t.stop_loss));
        const moveAbs = Math.abs(exitPrice - entry);
        const rMultiple = riskPerUnit > 0
          ? (moveAbs / riskPerUnit) * (pnlUsd >= 0 ? 1 : -1)
          : null;

        await sql`
          UPDATE trades
             SET status        = 'closed',
                 closed_at     = now(),
                 exit_price    = ${exitPrice},
                 pnl_usd       = ${pnlUsd},
                 r_multiple    = ${rMultiple},
                 exit_reason   = 'expired',
                 reconciled_at = now()
           WHERE id = ${t.id}
        `;
        await recordClose("binance", pnlUsd);
        summary.closedExternally.push(`${t.id} (${t.asset}: balance ${liveBalance} < expected ${expectedTotal})`);
      }
    } catch (e) {
      summary.errors.push(`${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Defensive: re-derive open_position_count for env=binance
  const openCountRow = (await sql`
    SELECT COUNT(*)::int AS n FROM trades
     WHERE environment = 'binance' AND status = 'open'
  `) as unknown as { n: number }[];
  await sql`
    UPDATE guardrail_state SET open_position_count = ${openCountRow[0]?.n ?? 0}
     WHERE environment = 'binance'
  `;

  return summary;
}
