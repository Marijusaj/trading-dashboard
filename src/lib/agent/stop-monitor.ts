// Stop monitor — enforces agent-managed stops and targets.
//
// In managed-stop environments (see guardrails.usesManagedStops) the broker
// only holds a wide safety stop; the stop and target that define the trade
// live in the `trades` row. This runs every minute from cron, with no model
// call: one rates request for all open trades, and a market close for any
// whose price has crossed its stop or target.
//
// Price can move past a level between passes, so a fill can be worse than
// the stop — that is the accepted cost of stops eToro would not hold.
import { db } from "@/lib/neon";
import { etoro } from "@/lib/etoro/client";
import { closeTrade } from "./execute";
import { usesManagedStops } from "./guardrails";
import type { AgentEnvironment } from "@/lib/neon";

interface MonitoredTrade {
  id: string;
  asset: string;
  instrument_id: number | string;
  side: "long" | "short";
  stop_loss: number | string;
  take_profit: number | string;
}

export interface StopMonitorReport {
  environment: AgentEnvironment;
  checked: number;
  closed: { tradeId: string; asset: string; reason: "stop" | "target"; price: number; level: number }[];
  errors: string[];
}

/** Which level, if any, the exit-side price has crossed. A long exits at
 *  the bid, a short at the ask. Stop wins if both are somehow crossed. */
export function crossedLevel(
  side: "long" | "short",
  stopLoss: number,
  takeProfit: number,
  quote: { bid: number; ask: number },
): { reason: "stop" | "target"; price: number; level: number } | null {
  const price = side === "long" ? quote.bid : quote.ask;
  const stopOk = Number.isFinite(stopLoss) && stopLoss > 0;
  const targetOk = Number.isFinite(takeProfit) && takeProfit > 0;
  if (stopOk && (side === "long" ? price <= stopLoss : price >= stopLoss)) {
    return { reason: "stop", price, level: stopLoss };
  }
  if (targetOk && (side === "long" ? price >= takeProfit : price <= takeProfit)) {
    return { reason: "target", price, level: takeProfit };
  }
  return null;
}

export async function enforceManagedStops(env: AgentEnvironment): Promise<StopMonitorReport> {
  const report: StopMonitorReport = { environment: env, checked: 0, closed: [], errors: [] };
  if (!usesManagedStops(env)) return report;

  const sql = db();
  const trades = (await sql`
    SELECT id, asset, instrument_id, side, stop_loss, take_profit
      FROM trades
     WHERE environment = ${env}
       AND status      = 'open'
       AND etoro_position_id IS NOT NULL
       AND etoro_position_id <> ''
  `) as unknown as MonitoredTrade[];
  report.checked = trades.length;
  if (trades.length === 0) return report;

  const rates = await etoro.getRates(trades.map((t) => Number(t.instrument_id)), env);
  const quoteById = new Map(rates.map((r) => [r.instrumentID, r]));

  for (const t of trades) {
    const quote = quoteById.get(Number(t.instrument_id));
    if (!quote) {
      report.errors.push(`${t.asset}: no rate`);
      continue;
    }
    const hit = crossedLevel(t.side, Number(t.stop_loss), Number(t.take_profit), quote);
    if (!hit) continue;
    try {
      const r = await closeTrade({
        env,
        tradeId: t.id,
        reason: hit.reason,
        reasoning: `MANAGED ${hit.reason.toUpperCase()}: ${t.side} ${t.asset} — price ${hit.price} crossed ${hit.reason} ${hit.level}`,
      });
      if (r.ok) report.closed.push({ tradeId: t.id, asset: t.asset, ...hit });
      // A failed close is usually a position the broker already closed
      // (its own target or safety stop) — reconcile books that one.
      else report.errors.push(`${t.asset}: ${r.message}`);
    } catch (e) {
      report.errors.push(`${t.asset}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
