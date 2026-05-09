// Binance Spot trade execution — long-only, USDC base.
//
// Differences from eToro execute.ts:
//   - No SL/TP at platform level (Binance spot doesn't OCO well; agent
//     manages exits via HVF triggers in binance-manage.ts)
//   - No leverage, no shorts (rejected up front)
//   - Market BUY uses quoteOrderQty (USDC); SELL uses base-asset qty
//   - Order returns immediately filled — no polling
//   - Position is tracked via base-asset balance + the trade row
//
// Stores rows with environment='binance', venue='binance' so the
// existing /api/agent/activity dashboard can surface them.

import { db } from "@/lib/neon";
import { binance } from "@/lib/binance/client";
import { binanceSymbol } from "@/lib/binance/symbols";
import { checkGuardrails, recordEntry, recordClose, type ProposedTrade } from "./guardrails";
import { sanitizeReasoning, type AgentKind } from "./execute";

export interface BinanceOpenRequest {
  asset: string;                    // universe symbol e.g. "TRX"
  sizeUsd: number;                  // USDC amount to spend
  reasoning: string;
  hvfScore: number;
  conviction: "high" | "medium" | "low";
  agentKind?: AgentKind;
}

export interface BinanceOpenResult {
  decisionId: string;
  tradeId: string | null;
  orderId: string | null;
  status: "executed" | "skipped_guardrail" | "failed";
  message: string;
  filledQty?: number;
  avgPrice?: number;
  guardrailViolation: string | null;
}

/**
 * Open a Binance spot LONG. Always BUY — no shorts on spot.
 * Sized in USDC via quoteOrderQty so we don't need to know the
 * fractional base-asset units up front.
 */
export async function openBinanceTrade(req: BinanceOpenRequest): Promise<BinanceOpenResult> {
  const sql = db();
  const cleanReasoning = sanitizeReasoning(req.reasoning);
  const pair = binanceSymbol(req.asset);
  if (!pair) {
    return {
      decisionId: "",
      tradeId: null,
      orderId: null,
      status: "failed",
      message: `No Binance USDC pair for ${req.asset}`,
      guardrailViolation: null,
    };
  }

  // Use a synthetic SL 50% below current price + TP 100% above so the
  // R-multiple math works downstream, even though Binance won't enforce
  // them. The auto-manager closes on HVF flip well before SL hits.
  let currentPrice = 0;
  try {
    currentPrice = await binance.price(pair);
  } catch {
    return {
      decisionId: "",
      tradeId: null,
      orderId: null,
      status: "failed",
      message: `Could not fetch ${pair} price`,
      guardrailViolation: null,
    };
  }
  const syntheticSL = currentPrice * 0.5;
  const syntheticTP = currentPrice * 2.0;

  // Guardrail check (size, daily loss, cooldown, R:R, etc.)
  const proposed: ProposedTrade = {
    environment: "binance",
    asset: req.asset,
    sizeUsd: req.sizeUsd,
    leverage: 1,
    stopLoss: syntheticSL,
    takeProfit: syntheticTP,
    entryPrice: currentPrice,
    direction: "long",
    minSizeUsd: 10,                  // Binance MIN_NOTIONAL is typically $5-10
    assetClass: "crypto",
  };
  const gate = await checkGuardrails(proposed);
  if (!gate.allowed) {
    const decRows = await sql`
      INSERT INTO agent_decisions (
        environment, agent_kind, decision_type, asset, reasoning,
        hvf_score, conviction, outcome_status, guardrail_violation, raw_context, venue
      ) VALUES (
        'binance', ${req.agentKind || 'strategic'}, 'open', ${req.asset}, ${cleanReasoning},
        ${req.hvfScore}, ${req.conviction}, 'skipped_guardrail',
        ${gate.violation}, ${JSON.stringify({ proposed, details: gate.details })}::jsonb,
        'binance'
      )
      RETURNING id
    ` as unknown as { id: string }[];
    return {
      decisionId: decRows[0].id,
      tradeId: null,
      orderId: null,
      status: "skipped_guardrail",
      message: `Blocked by guardrail: ${gate.violation}`,
      guardrailViolation: gate.violation,
    };
  }

  // Insert pending decision row
  const decRows = await sql`
    INSERT INTO agent_decisions (
      environment, agent_kind, decision_type, asset, reasoning,
      hvf_score, conviction, outcome_status, raw_context, venue
    ) VALUES (
      'binance', ${req.agentKind || 'strategic'}, 'open', ${req.asset}, ${cleanReasoning},
      ${req.hvfScore}, ${req.conviction}, 'pending',
      ${JSON.stringify({ proposed, details: gate.details })}::jsonb,
      'binance'
    )
    RETURNING id
  ` as unknown as { id: string }[];
  const decisionId = decRows[0].id;

  // Place the order
  try {
    const order = await binance.placeMarketOrder({
      symbol: pair,
      side: "BUY",
      quoteOrderQty: req.sizeUsd,
    });
    if (order.status !== "FILLED" && order.status !== "PARTIALLY_FILLED") {
      await sql`
        UPDATE agent_decisions
           SET outcome_status = 'failed',
               reasoning      = ${cleanReasoning + ` | ORDER_NOT_FILLED status=${order.status}`}
         WHERE id = ${decisionId}
      `;
      return {
        decisionId, tradeId: null, orderId: String(order.orderId),
        status: "failed",
        message: `Binance order status ${order.status}`,
        guardrailViolation: null,
      };
    }
    // Compute weighted-average fill price from fills[] if present, else use cumQuoteQty/executedQty
    const filledQty = order.executedQty;
    const filledCost = order.cummulativeQuoteQty || (req.sizeUsd);
    const avgPrice = filledQty > 0 ? filledCost / filledQty : currentPrice;

    const tradeRows = await sql`
      INSERT INTO trades (
        decision_id, environment, agent_kind, etoro_position_id, etoro_order_id,
        asset, instrument_id, side, entry_price, size_usd, units,
        stop_loss, take_profit, leverage, opened_at, status, venue
      ) VALUES (
        ${decisionId}, 'binance', ${req.agentKind || 'strategic'},
        ${String(order.orderId)}, ${String(order.orderId)},
        ${req.asset}, 0, 'long',
        ${avgPrice}, ${filledCost}, ${filledQty},
        ${syntheticSL}, ${syntheticTP}, 1,
        now(), 'open', 'binance'
      )
      RETURNING id
    ` as unknown as { id: string }[];
    const tradeId = tradeRows[0].id;

    await sql`
      UPDATE agent_decisions
         SET outcome_status = 'executed',
             trade_id       = ${tradeId},
             raw_context    = ${JSON.stringify({ proposed, order })}::jsonb
       WHERE id = ${decisionId}
    `;
    await recordEntry("binance");

    return {
      decisionId, tradeId, orderId: String(order.orderId),
      status: "executed",
      message: `Bought ${filledQty.toFixed(6)} ${req.asset} @ avg ${avgPrice.toFixed(6)} for $${filledCost.toFixed(2)} USDC`,
      filledQty, avgPrice,
      guardrailViolation: null,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE agent_decisions
         SET outcome_status = 'failed',
             reasoning      = ${cleanReasoning + ` | EXEC ERROR: ${errMsg}`}
       WHERE id = ${decisionId}
    `;
    return {
      decisionId, tradeId: null, orderId: null,
      status: "failed", message: errMsg,
      guardrailViolation: null,
    };
  }
}

export interface BinanceCloseRequest {
  tradeId: string;
  reason: "agent_close" | "stop" | "target" | "manual_close";
  reasoning: string;
  /** Optional: fraction of position to close (0.1-1.0). Default 1.0 (full close). */
  fraction?: number;
}

export async function closeBinanceTrade(req: BinanceCloseRequest): Promise<{
  ok: boolean;
  message: string;
  pnlUsd?: number;
  rMultiple?: number | null;
}> {
  const sql = db();
  const trades = await sql`
    SELECT id, asset, entry_price, size_usd, units, stop_loss, etoro_order_id
      FROM trades
     WHERE id = ${req.tradeId} AND environment = 'binance' AND status = 'open'
  ` as unknown as Array<{
    id: string;
    asset: string;
    entry_price: string | number;
    size_usd: string | number;
    units: string | number;
    stop_loss: string | number;
    etoro_order_id: string;
  }>;
  if (trades.length === 0) return { ok: false, message: "Trade not found or not open" };
  const t = trades[0];
  const pair = binanceSymbol(t.asset);
  if (!pair) return { ok: false, message: `No Binance pair for ${t.asset}` };

  const fraction = Math.max(0.1, Math.min(1.0, req.fraction ?? 1.0));
  const totalUnits = Number(t.units);
  const qtyToSell = Number((totalUnits * fraction).toFixed(6));

  let order;
  try {
    order = await binance.placeMarketOrder({
      symbol: pair,
      side: "SELL",
      quantity: qtyToSell,
    });
  } catch (e) {
    return { ok: false, message: `Binance SELL failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const filledQty = order.executedQty;
  const proceeds = order.cummulativeQuoteQty;
  const avgExitPrice = filledQty > 0 ? proceeds / filledQty : Number(t.entry_price);
  const entry = Number(t.entry_price);
  const costBasis = entry * filledQty;
  const pnlUsd = proceeds - costBasis;
  const riskPerUnit = Math.abs(entry - Number(t.stop_loss));
  const moveAbs = Math.abs(avgExitPrice - entry);
  const rMultiple = riskPerUnit > 0
    ? (moveAbs / riskPerUnit) * (pnlUsd >= 0 ? 1 : -1)
    : null;

  if (fraction >= 0.99) {
    // Full close
    await sql`
      UPDATE trades
         SET status      = 'closed',
             closed_at   = now(),
             exit_price  = ${avgExitPrice},
             pnl_usd     = ${pnlUsd},
             r_multiple  = ${rMultiple},
             exit_reason = ${req.reason},
             reconciled_at = now()
       WHERE id = ${t.id}
    `;
  } else {
    // Partial — reduce units, keep open
    const remaining = totalUnits - filledQty;
    await sql`
      UPDATE trades
         SET units = ${remaining},
             reconciled_at = now()
       WHERE id = ${t.id}
    `;
  }

  await sql`
    INSERT INTO agent_decisions (
      environment, agent_kind, decision_type, asset, reasoning,
      outcome_status, trade_id, venue
    ) VALUES (
      'binance', 'strategic',
      ${fraction >= 0.99 ? 'close' : 'modify'},
      ${t.asset},
      ${sanitizeReasoning(req.reasoning) + ` | Sold ${filledQty.toFixed(6)} @ ${avgExitPrice.toFixed(6)}, pnl ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${rMultiple?.toFixed(2) ?? '?'}R)`},
      'executed', ${t.id}, 'binance'
    )
  `;
  await recordClose("binance", pnlUsd);

  return {
    ok: true,
    message: `Sold ${filledQty.toFixed(6)} ${t.asset} @ ${avgExitPrice.toFixed(6)}, PnL ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${rMultiple?.toFixed(2) ?? '?'}R)`,
    pnlUsd,
    rMultiple,
  };
}
