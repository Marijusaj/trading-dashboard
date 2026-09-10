// Tool definitions for the Binance Spot agent (long-only).
//
// Smaller surface than eToro tools — no shorts, no leverage, no
// asset-class market-hours, no commodity CFDs. Spot crypto only.

import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/neon";
import { binance } from "@/lib/binance/client";
import { binanceSymbol } from "@/lib/binance/symbols";
import { scanBinanceUniverse } from "./binance-scanner";
import { openBinanceTrade, closeBinanceTrade } from "./binance-execute";
import { recordObservationDecision, sanitizeReasoning } from "./execute";
import type { ScanCandidate } from "./scanner";
import type { Strategy, StrategyName } from "./strategies/types";

export interface BinanceToolContext {
  /** Cache of universe scan results for this run */
  scanCache: ScanCandidate[] | null;
  /** Multi-strategy mode — when set, the scanner runs every strategy and
   *  surfaces results in `scan_universe`. Supplied by the loop from
   *  strategies/index.ts, which is the source of truth per environment. */
  strategies?: Strategy[];
}

export const BINANCE_TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "scan_universe",
    description:
      "Scan all universe symbols that have a Binance USDC pair. Returns HVF analysis on daily candles, ranked by score. Spot long-only — no shorts available on Binance. " +
      "In multi-strategy mode ALSO returns `strategyCandidates`: verdicts from every enabled strategy (hvf, trend_break, mean_revert, hvf_mtf). " +
      "Each strategy has its OWN scoring scale — do not compare scores across strategies. Pick the one whose setup fits the price action.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_open_positions",
    description: "Open Binance trades the agent owns (with synthetic SL/TP for R-math).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_account_equity",
    description: "USDC free balance + total value of all open base-asset balances at current mid prices.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_recent_decisions",
    description: "Recent Binance decisions (default 30d). For self-review.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "get_recent_trade_outcomes",
    description: "Closed Binance trades with realized PnL + R-multiple.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number" }, limit: { type: "number" } },
      required: [],
    },
  },
  {
    name: "open_position",
    description:
      "Open a LONG spot position on Binance. Always BUY (no shorts). Size in USDC. Subject to guardrails.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Universe symbol (e.g. 'TRX' or 'BTC')" },
        sizeUsd: { type: "number", description: "USDC amount to spend" },
        reasoning: { type: "string" },
        hvfScore: { type: "number", description: "Strategy score (0-100). Named hvfScore for backward compat but accepts any strategy's score." },
        conviction: { type: "string", enum: ["high", "medium", "low"] },
        strategy: {
          type: "string",
          enum: ["hvf", "trend_break", "mean_revert", "hvf_mtf"],
          description: "Which strategy triggered this trade. Required in multi-strategy mode. Defaults to 'hvf'.",
        },
      },
      required: ["symbol", "sizeUsd", "reasoning", "hvfScore", "conviction"],
    },
  },
  {
    name: "close_position",
    description: "Close a Binance trade FULLY (sell all units) by trade_id.",
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
    name: "close_position_partial",
    description: "Close PART of a Binance trade (fraction 0.1-0.9).",
    input_schema: {
      type: "object",
      properties: {
        tradeId: { type: "string" },
        fraction: { type: "number" },
        reasoning: { type: "string" },
      },
      required: ["tradeId", "fraction", "reasoning"],
    },
  },
  {
    name: "save_memory",
    description: "Persist a lesson, thesis, or note for future Binance runs.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["lesson", "thesis", "instrument_note", "self_review"] },
        asset: { type: "string" },
        content: { type: "string" },
        importance: { type: "number" },
      },
      required: ["category", "content"],
    },
  },
  {
    name: "record_observation",
    description: "Record this scan as a no-action decision. Always call AT MINIMUM once per scan.",
    input_schema: {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        topAsset: { type: "string", description: "Highest-conviction asset symbol (e.g. 'TRX')" },
        hvfScore: { type: "number" },
      },
      required: ["reasoning"],
    },
  },
];

export async function handleBinanceToolCall(
  ctx: BinanceToolContext,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
): Promise<unknown> {
  switch (toolName) {
    case "scan_universe": {
      const results = await scanBinanceUniverse({ strategies: ctx.strategies });
      ctx.scanCache = results;
      return results.map((c) => ({
        symbol: c.symbol,
        display: c.display,
        thesis: c.thesis,
        currentPrice: c.currentPrice,
        hvfScore: c.hvf.score,
        direction: c.hvf.direction,
        components: c.hvf.components,
        volumeDataAvailable: c.hvf.metrics.volumeDataAvailable,
        signals: c.hvf.signals,
        strategyCandidates: c.strategyCandidates?.map((sc) => ({
          strategy: sc.strategy,
          direction: sc.direction,
          score: sc.score,
          conviction: sc.conviction,
          reason: sc.reason,
          signals: sc.signals,
          entryPrice: sc.entryPrice,
          suggestedSL: sc.suggestedSL,
          suggestedTP: sc.suggestedTP,
          rewardRiskRatio: sc.rewardRiskRatio,
        })),
      }));
    }

    case "get_open_positions": {
      const sql = db();
      const rows = await sql`
        SELECT id, asset, side, entry_price, size_usd, units, stop_loss, take_profit,
               opened_at, etoro_position_id AS order_id
          FROM trades
         WHERE environment = 'binance' AND status = 'open'
         ORDER BY opened_at DESC
      `;
      return rows;
    }

    case "get_account_equity": {
      const acct = await binance.account();
      const usdc = acct.balances.find((b) => b.asset === "USDC");
      const usdcFree = usdc ? usdc.free : 0;
      const usdcLocked = usdc ? usdc.locked : 0;
      // Value of non-USDC balances at current mid
      let nonUsdcValue = 0;
      const breakdown: Array<{ asset: string; qty: number; usdValue: number }> = [];
      for (const b of acct.balances) {
        if (b.asset === "USDC" || b.asset === "USDT") continue;
        const total = b.free + b.locked;
        if (total <= 0) continue;
        const pair = `${b.asset}USDC`;
        try {
          const px = await binance.price(pair);
          const usdValue = total * px;
          nonUsdcValue += usdValue;
          breakdown.push({ asset: b.asset, qty: total, usdValue });
        } catch {
          // No USDC pair — skip valuation but still report
          breakdown.push({ asset: b.asset, qty: total, usdValue: 0 });
        }
      }
      return {
        canTrade: acct.canTrade,
        usdcFree,
        usdcLocked,
        nonUsdcValue,
        totalEquityUsd: usdcFree + usdcLocked + nonUsdcValue,
        breakdown,
      };
    }

    case "get_recent_decisions": {
      const days = input.days ?? 30;
      const limit = input.limit ?? 20;
      const sql = db();
      const rows = await sql`
        SELECT ts, decision_type, asset, reasoning, hvf_score, conviction, outcome_status, guardrail_violation
          FROM agent_decisions
         WHERE environment = 'binance' AND ts > now() - (${days} || ' days')::interval
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
         WHERE environment = 'binance' AND status = 'closed'
           AND closed_at > now() - (${days} || ' days')::interval
         ORDER BY closed_at DESC LIMIT ${limit}
      `;
      return rows;
    }

    case "open_position": {
      const cand = (ctx.scanCache || []).find((c) => c.symbol === input.symbol);
      if (!cand) return { error: `${input.symbol} not in latest scan. Call scan_universe first.` };
      if (!binanceSymbol(input.symbol)) {
        return { error: `${input.symbol} has no Binance USDC pair — cannot trade on Binance.` };
      }
      const VALID_STRATS: ReadonlySet<StrategyName> = new Set([
        "hvf", "trend_break", "mean_revert", "hvf_mtf",
      ]);
      const strategy: StrategyName =
        input.strategy && VALID_STRATS.has(input.strategy as StrategyName)
          ? (input.strategy as StrategyName)
          : "hvf";
      const result = await openBinanceTrade({
        asset: input.symbol,
        sizeUsd: Number(input.sizeUsd),
        reasoning: input.reasoning,
        hvfScore: Number(input.hvfScore),
        conviction: input.conviction,
        agentKind: "strategic",
        strategy,
      });
      return result;
    }

    case "close_position": {
      const r = await closeBinanceTrade({
        tradeId: input.tradeId,
        reason: input.reason,
        reasoning: input.reasoning,
        fraction: 1.0,
      });
      return r;
    }

    case "close_position_partial": {
      const fraction = Math.max(0.1, Math.min(0.9, Number(input.fraction)));
      const r = await closeBinanceTrade({
        tradeId: input.tradeId,
        reason: "agent_close",
        reasoning: input.reasoning,
        fraction,
      });
      return r;
    }

    case "save_memory": {
      const sql = db();
      const rows = await sql`
        INSERT INTO agent_memory (category, asset, content, importance)
        VALUES (${input.category}, ${input.asset || null},
                ${sanitizeReasoning(input.content)},
                ${input.importance ?? 5})
        RETURNING id
      ` as unknown as { id: string }[];
      return { id: rows[0].id, ok: true };
    }

    case "record_observation": {
      const cleanAsset = (input.topAsset && typeof input.topAsset === "string"
        ? input.topAsset.trim().toUpperCase()
        : null);
      const id = await recordObservationDecision("binance", {
        decisionType: "scan_only",
        asset: cleanAsset,
        reasoning: input.reasoning,
        hvfScore: input.hvfScore ?? ctx.scanCache?.[0]?.hvf.score ?? null,
        conviction: null,
        agentKind: "strategic",
      });
      return { id, ok: true };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
