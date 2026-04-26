// Trade execution layer — the ONLY path that hits eToro for orders.
// Every call here:
//   1. Validates against guardrails
//   2. Records the decision in `agent_decisions`
//   3. Calls eToro
//   4. Records the trade in `trades`
//   5. Updates guardrail state
//
// If anything throws, it's logged with outcome_status='failed'.
import { db } from "@/lib/neon";
import { etoro } from "@/lib/etoro/client";
import { checkGuardrails, recordEntry, recordClose, type ProposedTrade } from "./guardrails";
import type { AgentEnvironment } from "@/lib/neon";

export interface DecisionContext {
  decisionType: "open" | "close" | "modify" | "hold" | "scan_only";
  asset: string | null;
  reasoning: string;
  hvfScore: number | null;
  conviction: "high" | "medium" | "low" | null;
  rawContext?: unknown;
}

/** Record a non-trading decision (hold / scan_only). */
export async function recordObservationDecision(
  env: AgentEnvironment,
  ctx: DecisionContext,
): Promise<string> {
  const sql = db();
  const rows = await sql`
    INSERT INTO agent_decisions (
      environment, decision_type, asset, reasoning, hvf_score, conviction,
      outcome_status, raw_context
    ) VALUES (
      ${env}, ${ctx.decisionType}, ${ctx.asset}, ${ctx.reasoning},
      ${ctx.hvfScore}, ${ctx.conviction}, 'executed',
      ${ctx.rawContext ? JSON.stringify(ctx.rawContext) : null}::jsonb
    )
    RETURNING id
  ` as unknown as { id: string }[];
  return rows[0].id;
}

export interface OpenTradeRequest {
  env: AgentEnvironment;
  asset: string;
  instrumentId: number;
  direction: "long" | "short";
  sizeUsd: number;
  leverage: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string;
  hvfScore: number;
  conviction: "high" | "medium" | "low";
  rawContext?: unknown;
  /** eToro min position size for this asset's class (CFDs require $1000+) */
  minSizeUsd?: number;
}

export interface OpenTradeResult {
  decisionId: string;
  tradeId: string | null;
  etoroPositionId: string | null;
  status: "executed" | "skipped_guardrail" | "failed";
  message: string;
  guardrailViolation: string | null;
}

/** Open a position. All paths return a structured result; never throws. */
export async function openTrade(req: OpenTradeRequest): Promise<OpenTradeResult> {
  const sql = db();
  const proposed: ProposedTrade = {
    environment: req.env,
    asset: req.asset,
    sizeUsd: req.sizeUsd,
    leverage: req.leverage,
    stopLoss: req.stopLoss,
    takeProfit: req.takeProfit,
    entryPrice: req.entryPrice,
    direction: req.direction,
    minSizeUsd: req.minSizeUsd,
  };

  // ── 1. Guardrail check ───────────────────────────────────────
  const gate = await checkGuardrails(proposed);
  if (!gate.allowed) {
    const decRows = await sql`
      INSERT INTO agent_decisions (
        environment, decision_type, asset, reasoning, hvf_score, conviction,
        outcome_status, guardrail_violation, raw_context
      ) VALUES (
        ${req.env}, 'open', ${req.asset}, ${req.reasoning},
        ${req.hvfScore}, ${req.conviction}, 'skipped_guardrail',
        ${gate.violation}, ${JSON.stringify({ proposed, details: gate.details })}::jsonb
      )
      RETURNING id
    ` as unknown as { id: string }[];
    return {
      decisionId: decRows[0].id,
      tradeId: null,
      etoroPositionId: null,
      status: "skipped_guardrail",
      message: `Blocked by guardrail: ${gate.violation}`,
      guardrailViolation: gate.violation,
    };
  }

  // ── 2. Insert decision row (pending) ─────────────────────────
  const decRows = await sql`
    INSERT INTO agent_decisions (
      environment, decision_type, asset, reasoning, hvf_score, conviction,
      outcome_status, raw_context
    ) VALUES (
      ${req.env}, 'open', ${req.asset}, ${req.reasoning},
      ${req.hvfScore}, ${req.conviction}, 'pending',
      ${JSON.stringify({ proposed: req, details: gate.details })}::jsonb
    )
    RETURNING id
  ` as unknown as { id: string }[];
  const decisionId = decRows[0].id;

  // ── 3. Place order + poll until terminal ─────────────────────
  try {
    const { placement, finalInfo, outcome } = await etoro.openPositionAndAwait(
      req.env,
      {
        instrumentID: req.instrumentId,
        isBuy: req.direction === "long",
        amount: req.sizeUsd,
        leverage: req.leverage,
        stopLossRate: req.stopLoss,
        takeProfitRate: req.takeProfit,
      },
      { maxWaitMs: 12_000, intervalMs: 1_500 },
    );

    // ── REJECTED / CANCELLED ─────────────────────────────────
    if (outcome === "rejected" || outcome === "cancelled") {
      const errMsg = finalInfo.errorMessage
        ? `${finalInfo.errorMessage} (errorCode ${finalInfo.errorCode})`
        : `Order ${outcome} (statusID ${finalInfo.statusID})`;
      await sql`
        UPDATE agent_decisions
           SET outcome_status      = 'failed',
               reasoning           = ${req.reasoning + ` | ${outcome.toUpperCase()}: ${errMsg}`},
               raw_context         = ${JSON.stringify({ proposed: req, placement, finalInfo })}::jsonb
         WHERE id = ${decisionId}
      `;
      return {
        decisionId,
        tradeId: null,
        etoroPositionId: null,
        status: "failed",
        message: errMsg,
        guardrailViolation: null,
      };
    }

    // ── EXECUTED, PENDING (polling timed out), or PENDING_MARKET_OPEN
    // Persist trade in all three cases; status tracks reality.
    const tradeStatus = outcome === "executed" ? "open" : "open"; // pending also kept as open; reconciler updates later
    const etoroPositionId = finalInfo.positionID || ""; // empty when pending
    const openRate = finalInfo.openRate ?? req.entryPrice;
    const units = finalInfo.units || placement.unitsQueued || null;

    const tradeRows = await sql`
      INSERT INTO trades (
        decision_id, environment, etoro_position_id, asset, instrument_id,
        side, entry_price, size_usd, units, stop_loss, take_profit, leverage,
        status
      ) VALUES (
        ${decisionId}, ${req.env}, ${etoroPositionId || null}, ${req.asset},
        ${req.instrumentId}, ${req.direction},
        ${openRate}, ${req.sizeUsd},
        ${units}, ${req.stopLoss}, ${req.takeProfit},
        ${req.leverage}, ${tradeStatus}
      )
      RETURNING id
    ` as unknown as { id: string }[];
    const tradeId = tradeRows[0].id;

    const decOutcome = outcome === "executed" ? "executed" : "pending";
    await sql`
      UPDATE agent_decisions
         SET outcome_status = ${decOutcome},
             trade_id       = ${tradeId},
             raw_context    = ${JSON.stringify({ proposed: req, placement, finalInfo, outcome })}::jsonb
       WHERE id = ${decisionId}
    `;

    if (outcome === "executed") {
      await recordEntry(req.env);
    }

    const verb =
      outcome === "executed"
        ? `Opened ${req.direction} ${req.asset} @ ${openRate}`
        : outcome === "pending_market_open"
        ? `Order queued for market open (${req.direction} ${req.asset}, $${req.sizeUsd})`
        : `Order pending — poll timed out (orderID ${placement.orderID})`;

    return {
      decisionId,
      tradeId,
      etoroPositionId: etoroPositionId || null,
      status: outcome === "executed" ? "executed" : "skipped_guardrail",
      message: `${verb}, SL ${req.stopLoss}, TP ${req.takeProfit}`,
      guardrailViolation: null,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE agent_decisions
         SET outcome_status = 'failed',
             reasoning      = ${req.reasoning + ` | EXEC ERROR: ${errMsg}`}
       WHERE id = ${decisionId}
    `;
    return {
      decisionId,
      tradeId: null,
      etoroPositionId: null,
      status: "failed",
      message: errMsg,
      guardrailViolation: null,
    };
  }
}

export interface CloseTradeRequest {
  env: AgentEnvironment;
  tradeId: string;
  reason: "stop" | "target" | "agent_close" | "manual_close";
  reasoning: string;
}

export async function closeTrade(req: CloseTradeRequest): Promise<{ ok: boolean; message: string; pnlUsd?: number }> {
  const sql = db();
  const trades = await sql`
    SELECT id, etoro_position_id, environment, entry_price, size_usd,
           side, instrument_id, stop_loss, take_profit
      FROM trades
     WHERE id = ${req.tradeId} AND status = 'open'
  ` as unknown as Array<{
    id: string;
    etoro_position_id: string;
    environment: AgentEnvironment;
    entry_price: number;
    size_usd: number;
    side: "long" | "short";
    instrument_id: number;
    stop_loss: number;
    take_profit: number;
  }>;

  if (trades.length === 0) return { ok: false, message: "Trade not found or already closed" };
  const trade = trades[0];

  if (!trade.etoro_position_id) return { ok: false, message: "Trade has no eToro position ID" };

  try {
    await etoro.closePosition(req.env, trade.etoro_position_id, Number(trade.instrument_id));
  } catch (e) {
    return { ok: false, message: `eToro close failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Fetch current rate to compute realized PnL (best-effort)
  let exitPrice: number | null = null;
  let pnlUsd = 0;
  let rMultiple: number | null = null;
  try {
    const rates = await etoro.getRates([Number(trade.instrument_id)], req.env);
    if (rates.length > 0) {
      exitPrice = (rates[0].bid + rates[0].ask) / 2;
      const direction = trade.side === "long" ? 1 : -1;
      const pctMove = ((exitPrice - trade.entry_price) / trade.entry_price) * direction;
      pnlUsd = trade.size_usd * pctMove;
      // R-multiple = realized P&L / risk per unit at entry
      const riskPerUnit = Math.abs(trade.entry_price - trade.stop_loss);
      const moveAbs = Math.abs(exitPrice - trade.entry_price);
      if (riskPerUnit > 0) {
        rMultiple = (moveAbs / riskPerUnit) * (pnlUsd >= 0 ? 1 : -1);
      }
    }
  } catch {
    // Non-fatal — leave pnl null in DB
  }

  await sql`
    UPDATE trades
       SET status      = 'closed',
           closed_at   = now(),
           exit_price  = ${exitPrice},
           pnl_usd     = ${pnlUsd || null},
           r_multiple  = ${rMultiple},
           exit_reason = ${req.reason}
     WHERE id = ${req.tradeId}
  `;

  // Record decision
  await sql`
    INSERT INTO agent_decisions (
      environment, decision_type, asset, reasoning,
      outcome_status, trade_id
    ) VALUES (
      ${req.env}, 'close', NULL, ${req.reasoning},
      'executed', ${req.tradeId}
    )
  `;

  await recordClose(req.env, pnlUsd);

  return { ok: true, message: `Closed trade ${req.tradeId}`, pnlUsd };
}
