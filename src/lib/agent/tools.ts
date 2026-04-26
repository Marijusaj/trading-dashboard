// Tool definitions for FrancisAgent.
// Each tool has: a JSON schema (sent to Claude), and a handler function.
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/neon";
import { etoro } from "@/lib/etoro/client";
import { scanUniverse, type ScanCandidate } from "./scanner";
import { planRisk, analyzeHVF, type OHLC } from "./hvf";
import { openTrade, closeTrade, recordObservationDecision, type OpenTradeRequest } from "./execute";
import type { AgentEnvironment } from "@/lib/neon";

export interface AgentToolContext {
  environment: AgentEnvironment;
  // Cache of universe scan results for this run
  scanCache: ScanCandidate[] | null;
}

// ── Tool schemas (sent to Claude) ───────────────────────────────────

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "scan_universe",
    description:
      "Scan the curated universe (top 15 instruments) and return HVF analysis for each, ranked by score. Returns price, HVF score breakdown, signals, and risk metrics.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_open_positions",
    description: "Return all currently open positions for the active environment, with live PnL.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_account_equity",
    description: "Return cash balance, unrealized PnL, total equity for the active environment.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_recent_decisions",
    description: "Pull the agent's own past decisions for context. Default 30 days, optional asset filter.",
    input_schema: {
      type: "object",
      properties: {
        asset: { type: "string", description: "Filter by symbol e.g. 'BTC'. Omit for all." },
        days: { type: "number", description: "Lookback window in days (default 30)" },
        limit: { type: "number", description: "Max rows (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "get_recent_trade_outcomes",
    description: "Pull recent closed trades with PnL, R-multiple, exit reason. Use for self-review.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback in days (default 30)" },
        limit: { type: "number", description: "Max rows (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "compute_risk_plan",
    description:
      "Compute SL/TP/R:R for a proposed entry. Uses ATR + recent pivots. Returns the planned levels — ALWAYS call this before open_position.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        direction: { type: "string", enum: ["long", "short"] },
        entryPrice: { type: "number" },
      },
      required: ["symbol", "direction", "entryPrice"],
    },
  },
  {
    name: "open_position",
    description:
      "Open a new position on eToro. Will be blocked if it violates guardrails (size, leverage, cooldown, R:R, etc). Returns the result including any guardrail rejection reason.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        direction: { type: "string", enum: ["long", "short"] },
        sizeUsd: { type: "number", description: "Position size in USD" },
        leverage: { type: "number", description: "1 for spot/no leverage, up to env max" },
        stopLoss: { type: "number" },
        takeProfit: { type: "number" },
        reasoning: { type: "string", description: "1-3 sentence rationale; will be persisted" },
        hvfScore: { type: "number" },
        conviction: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["symbol", "direction", "sizeUsd", "leverage", "stopLoss", "takeProfit", "reasoning", "hvfScore", "conviction"],
    },
  },
  {
    name: "close_position",
    description: "Close an open trade by trade_id (returned by get_open_positions).",
    input_schema: {
      type: "object",
      properties: {
        tradeId: { type: "string" },
        reason: { type: "string", enum: ["agent_close", "stop", "target"] },
        reasoning: { type: "string" },
      },
      required: ["tradeId", "reason", "reasoning"],
    },
  },
  {
    name: "save_memory",
    description:
      "Persist a lesson, thesis, or instrument-specific note for future runs. Importance 1-10.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["lesson", "thesis", "instrument_note", "self_review"] },
        asset: { type: "string", description: "Optional asset symbol" },
        content: { type: "string" },
        importance: { type: "number", description: "1-10, default 5" },
      },
      required: ["category", "content"],
    },
  },
  {
    name: "record_observation",
    description:
      "Record this scan as a no-action decision (observation/hold). Always call this AT MINIMUM once per scan, even if you also took a trade.",
    input_schema: {
      type: "object",
      properties: {
        reasoning: { type: "string", description: "Summary of what you observed and why no action / what action" },
        topAsset: { type: "string", description: "Highest-conviction asset this scan, even if not traded" },
        hvfScore: { type: "number" },
      },
      required: ["reasoning"],
    },
  },
];

// ── Handler implementation ──────────────────────────────────────────

export async function handleToolCall(
  ctx: AgentToolContext,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
): Promise<unknown> {
  switch (toolName) {
    case "scan_universe": {
      const results = await scanUniverse();
      ctx.scanCache = results;
      return results.map((c) => ({
        symbol: c.symbol,
        display: c.display,
        thesis: c.thesis,
        currentPrice: c.currentPrice,
        hvfScore: c.hvf.score,
        direction: c.hvf.direction,
        components: c.hvf.components,
        metrics: {
          compressionRatio: c.hvf.metrics.compressionRatio,
          ema20: c.hvf.metrics.ema20,
          ema50: c.hvf.metrics.ema50,
          ema200: c.hvf.metrics.ema200,
          recentLow: c.hvf.metrics.recentLow,
          recentHigh: c.hvf.metrics.recentHigh,
          distanceToSupport: c.hvf.metrics.distanceToSupport,
          distanceToResistance: c.hvf.metrics.distanceToResistance,
        },
        signals: c.hvf.signals,
        shortAllowed: c.shortAllowed,
      }));
    }

    case "get_open_positions": {
      const sql = db();
      const rows = await sql`
        SELECT id, asset, side, entry_price, size_usd, stop_loss, take_profit,
               leverage, opened_at, etoro_position_id
          FROM trades
         WHERE environment = ${ctx.environment} AND status = 'open'
         ORDER BY opened_at DESC
      ` as unknown as Array<{ id: string; asset: string; side: string; entry_price: number; size_usd: number; stop_loss: number; take_profit: number; leverage: number; opened_at: string; etoro_position_id: string }>;
      return rows;
    }

    case "get_account_equity": {
      const portfolio = await etoro.getPortfolio(ctx.environment);
      return {
        cash: portfolio.credit,
        positionsCount: (portfolio.positions || []).length,
        ordersCount: (portfolio.orders || []).length,
      };
    }

    case "get_recent_decisions": {
      const days = input.days ?? 30;
      const limit = input.limit ?? 20;
      const sql = db();
      if (input.asset) {
        const rows = await sql`
          SELECT ts, decision_type, asset, reasoning, hvf_score, conviction,
                 outcome_status, guardrail_violation
            FROM agent_decisions
           WHERE environment = ${ctx.environment}
             AND ts > now() - (${days} || ' days')::interval
             AND asset = ${input.asset}
           ORDER BY ts DESC LIMIT ${limit}
        `;
        return rows;
      }
      const rows = await sql`
        SELECT ts, decision_type, asset, reasoning, hvf_score, conviction,
               outcome_status, guardrail_violation
          FROM agent_decisions
         WHERE environment = ${ctx.environment}
           AND ts > now() - (${days} || ' days')::interval
         ORDER BY ts DESC LIMIT ${limit}
      `;
      return rows;
    }

    case "get_recent_trade_outcomes": {
      const days = input.days ?? 30;
      const limit = input.limit ?? 20;
      const sql = db();
      const rows = await sql`
        SELECT id, asset, side, entry_price, exit_price, size_usd, pnl_usd,
               r_multiple, exit_reason, opened_at, closed_at
          FROM trades
         WHERE environment = ${ctx.environment}
           AND status = 'closed'
           AND closed_at > now() - (${days} || ' days')::interval
         ORDER BY closed_at DESC LIMIT ${limit}
      `;
      return rows;
    }

    case "compute_risk_plan": {
      const cand = (ctx.scanCache || []).find((c) => c.symbol === input.symbol);
      if (!cand) {
        return { error: `Symbol ${input.symbol} not in latest scan. Call scan_universe first.` };
      }
      const plan = planRisk({
        entryPrice: input.entryPrice,
        direction: input.direction,
        atr: cand.hvf.metrics.currentATR,
        recentLow: cand.hvf.metrics.recentLow,
        recentHigh: cand.hvf.metrics.recentHigh,
      });
      return plan;
    }

    case "open_position": {
      const cand = (ctx.scanCache || []).find((c) => c.symbol === input.symbol);
      if (!cand) {
        return { error: `Symbol ${input.symbol} not in latest scan. Call scan_universe first.` };
      }
      const req: OpenTradeRequest = {
        env: ctx.environment,
        asset: input.symbol,
        instrumentId: cand.instrumentId,
        direction: input.direction,
        sizeUsd: input.sizeUsd,
        leverage: input.leverage,
        entryPrice: cand.currentPrice,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        reasoning: input.reasoning,
        hvfScore: input.hvfScore,
        conviction: input.conviction,
      };
      const result = await openTrade(req);
      return result;
    }

    case "close_position": {
      const result = await closeTrade({
        env: ctx.environment,
        tradeId: input.tradeId,
        reason: input.reason,
        reasoning: input.reasoning,
      });
      return result;
    }

    case "save_memory": {
      const sql = db();
      const rows = await sql`
        INSERT INTO agent_memory (category, asset, content, importance)
        VALUES (${input.category}, ${input.asset || null}, ${input.content},
                ${input.importance ?? 5})
        RETURNING id
      ` as unknown as { id: string }[];
      return { id: rows[0].id, ok: true };
    }

    case "record_observation": {
      const id = await recordObservationDecision(ctx.environment, {
        decisionType: "scan_only",
        asset: input.topAsset || null,
        reasoning: input.reasoning,
        hvfScore: input.hvfScore ?? null,
        conviction: null,
      });
      return { id, ok: true };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// Helper: extract OHLC for a single instrument (used elsewhere)
export async function getInstrumentCandles(instrumentId: number): Promise<OHLC[]> {
  const candles = await etoro.getCandles(instrumentId, "OneDay", 250);
  return candles.map((c) => ({
    time: Math.floor(new Date(c.fromDate).getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

// Helper: get HVF for a single instrument
export async function getHvfForInstrument(instrumentId: number) {
  const candles = await getInstrumentCandles(instrumentId);
  return analyzeHVF(candles);
}
