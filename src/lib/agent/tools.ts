// Tool definitions for FrancisAgent.
// Each tool has: a JSON schema (sent to Claude), and a handler function.
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/neon";
import { etoro } from "@/lib/etoro/client";
import { scanUniverse, type ScanCandidate, type ScanOptions } from "./scanner";
import { planRisk, analyzeHVF, type OHLC } from "./hvf";
import { openTrade, closeTrade, recordObservationDecision, sanitizeReasoning, type OpenTradeRequest, type AgentKind } from "./execute";
import type { UniverseEntry } from "./universe";
import type { AgentEnvironment } from "@/lib/neon";
import type { Strategy, StrategyName } from "./strategies/types";

export interface AgentToolContext {
  environment: AgentEnvironment;
  // Cache of universe scan results for this run
  scanCache: ScanCandidate[] | null;
  /** Optional overrides — set by tactical agent to inject its universe etc. */
  overrides?: {
    universe?: UniverseEntry[];
    timeframe?: ScanOptions["timeframe"];
    agentKind?: AgentKind;
    /** Cap the position size the agent can request (tactical: $25 Real / $1000 Paper) */
    maxPositionSizeUsd?: number;
    /** Multi-strategy mode — when set, the scanner runs every strategy
     *  and surfaces results in `scan_universe` output. The agent then
     *  picks a strategy by name in open_position. */
    strategies?: Strategy[];
  };
}

/**
 * Extract a clean symbol from possibly-noisy `topAsset` input.
 * Haiku occasionally stuffs commentary in: "DOGE (40.3 HVF, rejected)".
 * Strategy: pull the first 1-6 char uppercase token; if it matches an
 * allowed universe symbol, return that — else return null (better to
 * lose a label than to pollute analytics with prose).
 */
function extractSymbol(raw: unknown, universe?: UniverseEntry[]): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Quick path: clean ticker already (2-6 upper chars)
  if (/^[A-Z][A-Z0-9]{1,5}$/.test(trimmed)) return trimmed;
  // Pull first 2-6 char uppercase run; isolated single capital letters
  // (sentence starts) are deliberately ignored.
  const m = trimmed.match(/\b[A-Z][A-Z0-9]{1,5}\b/);
  if (!m) return null;
  const sym = m[0];
  if (universe && universe.length > 0) {
    return universe.some((u) => u.symbol === sym) ? sym : null;
  }
  return sym;
}

// ── Tool schemas (sent to Claude) ───────────────────────────────────

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "scan_universe",
    description:
      "Scan the curated universe and return per-asset analysis. " +
      "Always returns HVF score + components. In multi-strategy mode (paper / binance) ALSO returns " +
      "`strategyCandidates`: a list of entries from every enabled strategy (hvf, trend_break, mean_revert, hvf_mtf). " +
      "Each strategy has its OWN scoring scale — do not compare scores across strategies. " +
      "Pick the strategy whose setup most clearly fits the asset's current price action.",
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
      "Open a new position on eToro. Will be blocked if it violates guardrails (size, leverage, cooldown, R:R, etc). Returns the result including any guardrail rejection reason. " +
      "Pass `strategy` to label the trade with the strategy that triggered it — required when scan_universe surfaced strategyCandidates. " +
      "Defaults to 'hvf' if omitted (legacy real-env path).",
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
        hvfScore: { type: "number", description: "Strategy score (0-100). Field is named hvfScore for backward compat but accepts any strategy's score." },
        conviction: { type: "string", enum: ["high", "medium", "low"] },
        strategy: {
          type: "string",
          enum: ["hvf", "trend_break", "mean_revert", "hvf_mtf"],
          description:
            "Which strategy triggered this trade. Required in multi-strategy envs (paper, binance). Defaults to 'hvf'.",
        },
      },
      required: ["symbol", "direction", "sizeUsd", "leverage", "stopLoss", "takeProfit", "reasoning", "hvfScore", "conviction"],
    },
  },
  {
    name: "close_position",
    description: "Close an open trade FULLY by trade_id (returned by get_open_positions).",
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
    description:
      "Close PART of an open trade. fraction=0.5 closes half, leaves the other half running. " +
      "Use this at +1R MFE to lock in a partial win while letting winners run.",
    input_schema: {
      type: "object",
      properties: {
        tradeId: { type: "string" },
        fraction: { type: "number", description: "0.1-0.9 — fraction of position to close" },
        reasoning: { type: "string" },
      },
      required: ["tradeId", "fraction", "reasoning"],
    },
  },
  {
    name: "get_position_status",
    description:
      "Quantitative status of all open agent trades for this env: live price, unrealized PnL$, " +
      "PnL% on margin, R-multiple (MFE/MAE in units of risk), age in hours, distance to SL/TP. " +
      "Call BEFORE deciding whether to hold/close/partial-close.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
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
        topAsset: {
          type: "string",
          description:
            "Highest-conviction asset this scan — SYMBOL ONLY, e.g. 'AVAX' or 'LINK'. " +
            "Must be plain symbol with no parens, parentheticals, scores, or commentary.",
        },
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
      const results = await scanUniverse({
        universe: ctx.overrides?.universe,
        timeframe: ctx.overrides?.timeframe,
        strategies: ctx.overrides?.strategies,
      });
      ctx.scanCache = results;
      return results.map((c) => ({
        symbol: c.symbol,
        display: c.display,
        assetClass: c.assetClass,
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
          volumeDataAvailable: c.hvf.metrics.volumeDataAvailable,
        },
        signals: c.hvf.signals,
        shortAllowed: c.shortAllowed,
        marketIsOpen: c.marketIsOpen,
        marketHoursReason: c.marketHoursReason,
        // Multi-strategy mode: surface every strategy's verdict. The agent
        // should pick the one that best fits the price action — not just
        // the highest-scoring one (scores aren't comparable across
        // strategies).
        strategyCandidates: c.strategyCandidates?.map((s) => ({
          strategy: s.strategy,
          direction: s.direction,
          score: s.score,
          conviction: s.conviction,
          reason: s.reason,
          signals: s.signals,
          entryPrice: s.entryPrice,
          suggestedSL: s.suggestedSL,
          suggestedTP: s.suggestedTP,
          rewardRiskRatio: s.rewardRiskRatio,
        })),
      }));
    }

    case "get_open_positions": {
      const sql = db();
      const agentTrades = await sql`
        SELECT id, asset, side, entry_price, size_usd, stop_loss, take_profit,
               leverage, opened_at, etoro_position_id
          FROM trades
         WHERE environment = ${ctx.environment} AND status = 'open'
         ORDER BY opened_at DESC
      ` as unknown as Array<{ id: string; asset: string; side: string; entry_price: number; size_usd: number; stop_loss: number; take_profit: number; leverage: number; opened_at: string; etoro_position_id: string }>;

      // Also surface any eToro positions NOT yet adopted into the trades
      // table. These are positions opened outside the agent's lifecycle
      // (manually placed before adoption ran). The user has indicated the
      // agent should manage all positions — surface these as "unadopted"
      // so the agent can request they be adopted (via admin) or evaluate
      // them for closing on the next pass.
      const portfolio = await etoro.getPortfolio(ctx.environment);
      const agentPositionIds = new Set(agentTrades.map((t) => t.etoro_position_id).filter(Boolean));
      const unadoptedPositions = portfolio.positions.filter(
        (p) => !agentPositionIds.has(p.positionID),
      );
      return {
        agentTrades,
        unadoptedPositions: unadoptedPositions.map((p) => ({
          positionID: p.positionID,
          instrumentID: p.instrumentID,
          side: p.isBuy ? "long" : "short",
          openRate: p.openRate,
          amountUsd: p.amountInDollars,
          openDate: p.openDateTime,
          unrealizedPnL: p.netProfit,
        })),
        note: "agentTrades are positions the agent owns and manages (close/modify allowed). " +
              "unadoptedPositions are eToro positions not yet registered as trades; if you " +
              "want to manage them, ask the user to run ?adoptAll=" + ctx.environment + " " +
              "or ?adoptPosition=positionId — once adopted they become agentTrades.",
      };
    }

    case "get_account_equity": {
      const portfolio = await etoro.getPortfolio(ctx.environment);
      return {
        cash: portfolio.credit,
        ownPositionsCount: portfolio.positions.length,
        mirrorPositionsCount: portfolio.mirrorPositions.length,
        pendingOrdersCount: portfolio.pendingOrders.length,
        // Hint to the agent — only ownPositions count toward our limits
        note: "ownPositionsCount excludes copy-trader (mirror) positions which the agent does not control",
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
      // Broker minimum stop pct — eToro silently widens crypto stops <5.5%
      // (shorts especially), kills R:R. planRisk pads outward to this.
      // Same table as guardrails.ts MIN_SL_DISTANCE_PCT.
      const minStopMap: Record<string, { long: number; short: number }> = {
        crypto:    { long: 1.5, short: 5.5 },
        commodity: { long: 2.5, short: 2.5 },
        equity:    { long: 1.5, short: 1.5 },
        etf:       { long: 1.5, short: 1.5 },
      };
      const ac = cand.assetClass as keyof typeof minStopMap;
      const minStopPct = minStopMap[ac]?.[input.direction as "long" | "short"] ?? 1.5;
      const plan = planRisk({
        entryPrice: input.entryPrice,
        direction: input.direction,
        atr: cand.hvf.metrics.currentATR,
        recentLow: cand.hvf.metrics.recentLow,
        recentHigh: cand.hvf.metrics.recentHigh,
        minStopPct,
      });
      return { ...plan, minStopPctApplied: minStopPct };
    }

    case "open_position": {
      const cand = (ctx.scanCache || []).find((c) => c.symbol === input.symbol);
      if (!cand) {
        return { error: `Symbol ${input.symbol} not in latest scan. Call scan_universe first.` };
      }
      // Resolve universe entry from whichever universe is active for this run
      const activeUniverse = ctx.overrides?.universe;
      const uEntry = activeUniverse
        ? activeUniverse.find((u) => u.symbol === input.symbol)
        : (await import("./universe")).getUniverseEntry(input.symbol);

      // Tactical cap: if requested size exceeds the agent-kind cap, clamp it
      const maxOverride = ctx.overrides?.maxPositionSizeUsd;
      const sizeUsd = maxOverride !== undefined
        ? Math.min(input.sizeUsd, maxOverride)
        : input.sizeUsd;

      // Strategy label. Default to 'hvf' for backward compat. Reject
      // unknown strategy names rather than silently coerce.
      const VALID_STRATS: ReadonlySet<StrategyName> = new Set([
        "hvf", "trend_break", "mean_revert", "hvf_mtf",
      ]);
      const strategy: StrategyName =
        input.strategy && VALID_STRATS.has(input.strategy as StrategyName)
          ? (input.strategy as StrategyName)
          : "hvf";

      const req: OpenTradeRequest = {
        env: ctx.environment,
        asset: input.symbol,
        instrumentId: cand.instrumentId,
        direction: input.direction,
        sizeUsd,
        leverage: input.leverage,
        entryPrice: cand.currentPrice,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        reasoning: input.reasoning,
        hvfScore: input.hvfScore,
        conviction: input.conviction,
        minSizeUsd: uEntry?.minSizeUsd,
        assetClass: uEntry?.assetClass,
        agentKind: ctx.overrides?.agentKind,
        strategy,
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

    case "close_position_partial": {
      const fraction = Math.max(0.1, Math.min(0.9, Number(input.fraction)));
      const sql = db();
      const rows = (await sql`
        SELECT id, etoro_position_id, instrument_id, units, environment, asset
          FROM trades
         WHERE id = ${input.tradeId} AND status = 'open'
      `) as unknown as Array<{ id: string; etoro_position_id: string; instrument_id: number; units: string | number; environment: typeof ctx.environment; asset: string }>;
      if (rows.length === 0) return { error: "Trade not found or not open" };
      const t = rows[0];
      if (!t.etoro_position_id) return { error: "Trade has no eToro position ID — pending order" };
      let totalUnits = Number(t.units);
      // Fallback: if DB column is null/0 (e.g. trade was recovered via
      // ?relinkTrade after a reconciler bug), fetch units live from
      // eToro portfolio + persist back to DB so future partials are fast.
      if (!totalUnits || totalUnits <= 0) {
        try {
          const portfolio = await etoro.getPortfolio(ctx.environment);
          const livePos = portfolio.positions.find((p) => String(p.positionID) === t.etoro_position_id);
          const liveUnits = Number(livePos?.units ?? 0);
          if (liveUnits > 0) {
            totalUnits = liveUnits;
            await sql`UPDATE trades SET units = ${liveUnits} WHERE id = ${t.id}`;
          }
        } catch { /* ignore, fall through to error */ }
      }
      if (!totalUnits || totalUnits <= 0) return { error: "Trade has unknown unit count, cannot partial close (eToro position not found in portfolio)" };
      const unitsToClose = Number((totalUnits * fraction).toFixed(6));
      try {
        await etoro.closePosition(ctx.environment, t.etoro_position_id, Number(t.instrument_id), unitsToClose);
        // Update DB units to reflect remaining
        const remaining = totalUnits - unitsToClose;
        await sql`
          UPDATE trades
             SET units = ${remaining},
                 reconciled_at = now()
           WHERE id = ${t.id}
        `;
        // Log a 'modify' decision
        const cleanReasoning = sanitizeReasoning(input.reasoning);
        await sql`
          INSERT INTO agent_decisions (
            environment, agent_kind, decision_type, asset, reasoning, outcome_status, trade_id
          ) VALUES (
            ${ctx.environment}, ${ctx.overrides?.agentKind || 'strategic'},
            'modify', ${t.asset},
            ${`PARTIAL CLOSE ${(fraction * 100).toFixed(0)}% (${unitsToClose} units, ${remaining} remaining): ${cleanReasoning}`},
            'executed', ${t.id}
          )
        `;
        return { ok: true, closed_units: unitsToClose, remaining_units: remaining, fraction };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "get_position_status": {
      const sql = db();
      const trades = (await sql`
        SELECT id, asset, instrument_id, side, entry_price, size_usd,
               stop_loss, take_profit, leverage, opened_at, etoro_position_id
          FROM trades
         WHERE environment = ${ctx.environment} AND status = 'open'
           AND etoro_position_id IS NOT NULL AND etoro_position_id <> ''
         ORDER BY opened_at DESC
      `) as unknown as Array<{ id: string; asset: string; instrument_id: number; side: "long" | "short"; entry_price: string | number; size_usd: string | number; stop_loss: string | number; take_profit: string | number; leverage: string | number; opened_at: string; etoro_position_id: string }>;
      if (trades.length === 0) return [];

      const ids = [...new Set(trades.map((t) => Number(t.instrument_id)))];
      const rates = await etoro.getRates(ids, ctx.environment);
      const rateMap = new Map(rates.map((r) => [r.instrumentID, (r.bid + r.ask) / 2]));

      return trades.map((t) => {
        const entry = Number(t.entry_price);
        const sl = Number(t.stop_loss);
        const tp = Number(t.take_profit);
        const size = Number(t.size_usd);
        const lev = Number(t.leverage) || 1;
        const mid = rateMap.get(Number(t.instrument_id)) ?? null;
        const dirMul = t.side === "long" ? 1 : -1;
        const pctMove = mid !== null ? ((mid - entry) / entry) * dirMul : null;
        const pnlUsd = pctMove !== null ? size * pctMove * lev : null;
        const riskPerUnit = Math.abs(entry - sl);
        const rMultiple = pctMove !== null && riskPerUnit > 0
          ? (Math.abs(mid! - entry) * (pctMove >= 0 ? 1 : -1)) / riskPerUnit
          : null;
        const ageHours = (Date.now() - new Date(t.opened_at).getTime()) / 3_600_000;
        return {
          tradeId: t.id,
          asset: t.asset,
          side: t.side,
          entry,
          currentPrice: mid,
          stopLoss: sl,
          takeProfit: tp,
          sizeUsd: size,
          ageHours: Number(ageHours.toFixed(1)),
          unrealizedPnLUsd: pnlUsd !== null ? Number(pnlUsd.toFixed(2)) : null,
          unrealizedPnLPct: pctMove !== null ? Number((pctMove * 100).toFixed(2)) : null,
          rMultiple: rMultiple !== null ? Number(rMultiple.toFixed(2)) : null,
          distToSlPct: mid !== null ? Number((((sl - mid) / mid) * 100 * dirMul * -1).toFixed(2)) : null,
          distToTpPct: mid !== null ? Number((((tp - mid) / mid) * 100 * dirMul).toFixed(2)) : null,
        };
      });
    }

    case "save_memory": {
      const sql = db();
      const cleanContent = sanitizeReasoning(input.content);
      const rows = await sql`
        INSERT INTO agent_memory (category, asset, content, importance)
        VALUES (${input.category}, ${input.asset || null}, ${cleanContent},
                ${input.importance ?? 5})
        RETURNING id
      ` as unknown as { id: string }[];
      return { id: rows[0].id, ok: true };
    }

    case "record_observation": {
      // Extract just the symbol from topAsset — Haiku sometimes stuffs
      // commentary in (e.g. "DOGE (40.3 HVF, but rejected on threshold)")
      // which pollutes per-asset analytics.
      // If Haiku omits topAsset entirely (~17% of calls observed),
      // fall back to the highest-HVF symbol from the latest scan.
      const cleanAsset =
        extractSymbol(input.topAsset, ctx.overrides?.universe) ??
        ctx.scanCache?.[0]?.symbol ??
        null;
      // Same fallback for hvfScore if missing.
      const hvfScore = input.hvfScore ?? ctx.scanCache?.[0]?.hvf?.score ?? null;
      const id = await recordObservationDecision(ctx.environment, {
        decisionType: "scan_only",
        asset: cleanAsset,
        reasoning: input.reasoning,
        hvfScore,
        conviction: null,
        agentKind: ctx.overrides?.agentKind,
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
    volume: c.volume ?? undefined,
  }));
}

// Helper: get HVF for a single instrument
export async function getHvfForInstrument(instrumentId: number) {
  const candles = await getInstrumentCandles(instrumentId);
  return analyzeHVF(candles);
}
