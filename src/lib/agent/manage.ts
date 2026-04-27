// Position management — runs at the start of every agent scan,
// BEFORE the model reasons. Auto-closes open agent trades whose
// underlying setup has degraded.
//
// Triggers:
//   1. HVF direction flip — was opened short, current HVF says long (or vice versa)
//   2. HVF score collapse — was opened with score 65+, current < 35 (signal gone)
//   3. Time stop — trade older than N candles for its timeframe and not in profit
//
// Each auto-close becomes an agent_decisions row of type 'close'
// so the agent sees what happened on its next reasoning pass.
import { db } from "@/lib/neon";
import { etoro } from "@/lib/etoro/client";
import { recordClose } from "./guardrails";
import { analyzeHVF } from "./hvf";
import type { CandlePeriod } from "./scanner";
import type { AgentEnvironment } from "@/lib/neon";
import type { AgentKind } from "./execute";

interface OpenTradeRow {
  id: string;
  environment: AgentEnvironment;
  agent_kind: AgentKind;
  etoro_position_id: string;
  asset: string;
  instrument_id: number;
  side: "long" | "short";
  entry_price: string | number;
  size_usd: string | number;
  stop_loss: string | number;
  take_profit: string | number;
  opened_at: string;
}

export interface ManageReport {
  scanned: number;
  closed: { id: string; asset: string; reason: string }[];
  held:    { id: string; asset: string; reason: string }[];
  errors:  string[];
}

const TIMEFRAME_BY_KIND: Record<AgentKind, { period: CandlePeriod; lookback: number; staleHours: number }> = {
  strategic: { period: "OneDay",         lookback: 250, staleHours: 7 * 24 },
  tactical:  { period: "FifteenMinutes", lookback: 250, staleHours: 12 },
};

/** For each open agent trade, decide whether to auto-close before reasoning. */
export async function autoManageOpenPositions(
  env: AgentEnvironment,
  agentKind: AgentKind,
): Promise<ManageReport> {
  const report: ManageReport = { scanned: 0, closed: [], held: [], errors: [] };
  const sql = db();

  const trades = (await sql`
    SELECT id, environment, agent_kind, etoro_position_id, asset, instrument_id,
           side, entry_price, size_usd, stop_loss, take_profit, opened_at
      FROM trades
     WHERE environment = ${env}
       AND agent_kind  = ${agentKind}
       AND status      = 'open'
       AND etoro_position_id IS NOT NULL
       AND etoro_position_id <> ''
  `) as unknown as OpenTradeRow[];

  report.scanned = trades.length;
  if (trades.length === 0) return report;

  const tf = TIMEFRAME_BY_KIND[agentKind];

  for (const t of trades) {
    try {
      // Pull fresh candles on the trade's timeframe + run HVF
      const rawCandles = await etoro.getCandles(Number(t.instrument_id), tf.period, tf.lookback);
      const candles = rawCandles.map((c) => ({
        time: Math.floor(new Date(c.fromDate).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      const hvf = candles.length >= 60 ? analyzeHVF(candles) : null;

      const ageHours = (Date.now() - new Date(t.opened_at).getTime()) / 3_600_000;

      // ── Trigger 1: HVF direction flip ────────────────────────
      if (hvf && hvf.direction !== "neutral" && hvf.direction !== t.side) {
        const reason = `Signal flipped — opened ${t.side}, current HVF dir=${hvf.direction} (score ${hvf.score.toFixed(0)})`;
        await closeAndLog(t, reason, "agent_close", report);
        continue;
      }

      // ── Trigger 2: HVF score collapse (only for tactical) ─────
      // Strategic uses macro thesis, doesn't care if 1d HVF dipped.
      // Tactical lives and dies by 15m HVF — collapse = exit.
      if (agentKind === "tactical" && hvf && hvf.score < 35) {
        const reason = `HVF collapsed — entry needed >=70, current ${hvf.score.toFixed(0)} (signal gone)`;
        await closeAndLog(t, reason, "agent_close", report);
        continue;
      }

      // ── Trigger 3: Time stop — only auto-close if BOTH stale AND not in profit
      if (ageHours > tf.staleHours) {
        // Get current price to check if in profit
        const rates = await etoro.getRates([Number(t.instrument_id)], env);
        const mid = rates[0] ? (rates[0].bid + rates[0].ask) / 2 : null;
        if (mid !== null) {
          const entry = Number(t.entry_price);
          const directionMul = t.side === "long" ? 1 : -1;
          const pctMove = ((mid - entry) / entry) * directionMul;
          if (pctMove < 0) {
            const reason = `Stale + losing — ${ageHours.toFixed(0)}h old (>${tf.staleHours}h), ${(pctMove * 100).toFixed(2)}% adverse`;
            await closeAndLog(t, reason, "expired", report);
            continue;
          }
        }
      }

      report.held.push({
        id: t.id,
        asset: t.asset,
        reason: hvf
          ? `HVF dir=${hvf.direction} score=${hvf.score.toFixed(0)} — still aligned`
          : `Insufficient candle data to re-score`,
      });
    } catch (e) {
      report.errors.push(`${t.id} (${t.asset}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return report;
}

async function closeAndLog(
  t: OpenTradeRow,
  reason: string,
  exitReason: "stop" | "target" | "agent_close" | "manual_close" | "expired",
  report: ManageReport,
): Promise<void> {
  const sql = db();
  try {
    await etoro.closePosition(t.environment, t.etoro_position_id, Number(t.instrument_id));

    // Best-effort PnL — fetch current rate
    let pnlUsd = 0;
    try {
      const rates = await etoro.getRates([Number(t.instrument_id)], t.environment);
      if (rates.length > 0) {
        const exitPrice = (rates[0].bid + rates[0].ask) / 2;
        const direction = t.side === "long" ? 1 : -1;
        const pctMove = ((exitPrice - Number(t.entry_price)) / Number(t.entry_price)) * direction;
        pnlUsd = Number(t.size_usd) * pctMove;
      }
    } catch {
      // PnL unknown
    }

    await sql`
      UPDATE trades
         SET status        = 'closed',
             closed_at     = now(),
             exit_reason   = ${exitReason},
             pnl_usd       = ${pnlUsd || null},
             reconciled_at = now()
       WHERE id = ${t.id}
    `;

    // Record a close decision so the agent sees it next scan
    await sql`
      INSERT INTO agent_decisions (
        environment, agent_kind, decision_type, asset, reasoning,
        outcome_status, trade_id
      ) VALUES (
        ${t.environment}, ${t.agent_kind}, 'close', ${t.asset},
        ${'AUTO-MANAGED: ' + reason},
        'executed', ${t.id}
      )
    `;

    await recordClose(t.environment, pnlUsd);
    report.closed.push({ id: t.id, asset: t.asset, reason });
  } catch (e) {
    report.errors.push(`close ${t.id} (${t.asset}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
