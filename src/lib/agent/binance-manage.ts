// Binance auto-manager — runs at the start of every Binance scan,
// BEFORE the model reasons. Auto-closes long-only spot positions whose
// HVF setup has degraded.
//
// Triggers (each closes via Binance SELL + logs decision):
//   1. HVF direction flip — opened long, current HVF says short → close
//   2. HVF score collapse — current HVF score < 35 → close
//   3. Time stop — older than 7 days AND not in profit → close

import { db } from "@/lib/neon";
import { binance } from "@/lib/binance/client";
import { binanceSymbol } from "@/lib/binance/symbols";
import { closeBinanceTrade } from "./binance-execute";
import { analyzeHVF } from "./hvf";

interface OpenBinanceTradeRow {
  id: string;
  asset: string;
  entry_price: string | number;
  units: string | number;
  opened_at: string;
}

export interface BinanceManageReport {
  scanned: number;
  closed: { id: string; asset: string; reason: string }[];
  held:    { id: string; asset: string; reason: string }[];
  errors:  string[];
}

const STALE_HOURS = 7 * 24;     // 1 week — same as eToro strategic
const HVF_COLLAPSE_THRESHOLD = 35;
const CANDLE_LOOKBACK = 250;

export async function autoManageBinancePositions(): Promise<BinanceManageReport> {
  const report: BinanceManageReport = { scanned: 0, closed: [], held: [], errors: [] };
  const sql = db();

  const trades = (await sql`
    SELECT id, asset, entry_price, units, opened_at
      FROM trades
     WHERE environment = 'binance' AND status = 'open'
  `) as unknown as OpenBinanceTradeRow[];

  report.scanned = trades.length;
  if (trades.length === 0) return report;

  for (const t of trades) {
    try {
      const pair = binanceSymbol(t.asset);
      if (!pair) continue;

      const klines = await binance.klines(pair, "1d", CANDLE_LOOKBACK);
      const ohlc = klines.map((k) => ({
        time: Math.floor(k.openTime / 1000),
        open: k.open, high: k.high, low: k.low, close: k.close,
      }));
      const hvf = ohlc.length >= 60 ? analyzeHVF(ohlc) : null;

      const ageHours = (Date.now() - new Date(t.opened_at).getTime()) / 3_600_000;

      // Trigger 1: HVF direction flip — long position but HVF says short
      if (hvf && hvf.direction === "short") {
        const reason = `Signal flipped — opened long, current HVF dir=short (score ${hvf.score.toFixed(0)})`;
        const r = await closeBinanceTrade({ tradeId: t.id, reason: "agent_close", reasoning: `AUTO-MANAGED: ${reason}` });
        if (r.ok) report.closed.push({ id: t.id, asset: t.asset, reason });
        else report.errors.push(`close ${t.id}: ${r.message}`);
        continue;
      }

      // Trigger 2: HVF score collapse
      if (hvf && hvf.score < HVF_COLLAPSE_THRESHOLD) {
        const reason = `HVF collapsed — current ${hvf.score.toFixed(0)} (signal gone)`;
        const r = await closeBinanceTrade({ tradeId: t.id, reason: "agent_close", reasoning: `AUTO-MANAGED: ${reason}` });
        if (r.ok) report.closed.push({ id: t.id, asset: t.asset, reason });
        else report.errors.push(`close ${t.id}: ${r.message}`);
        continue;
      }

      // Trigger 3: Time stop (only if losing)
      if (ageHours > STALE_HOURS) {
        let mid: number | null = null;
        try { mid = await binance.price(pair); } catch { /* ignore */ }
        if (mid !== null) {
          const entry = Number(t.entry_price);
          const pctMove = ((mid - entry) / entry);
          if (pctMove < 0) {
            const reason = `Stale + losing — ${ageHours.toFixed(0)}h old (>${STALE_HOURS}h), ${(pctMove * 100).toFixed(2)}% adverse`;
            const r = await closeBinanceTrade({ tradeId: t.id, reason: "manual_close", reasoning: `AUTO-MANAGED: ${reason}` });
            if (r.ok) report.closed.push({ id: t.id, asset: t.asset, reason });
            else report.errors.push(`close ${t.id}: ${r.message}`);
            continue;
          }
        }
      }

      report.held.push({
        id: t.id, asset: t.asset,
        reason: hvf ? `HVF dir=${hvf.direction} score=${hvf.score.toFixed(0)} — still aligned` : "insufficient candle data",
      });
    } catch (e) {
      report.errors.push(`${t.id} (${t.asset}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return report;
}
