// HVF strategy — Francis Hunt's Hunt Volatility Funnel.
// Wraps analyzeHVF + planRisk into the unified Strategy interface.

import { analyzeHVF } from "../hvf";
import { planRisk } from "../hvf";
import type { Strategy, StrategyCandidate } from "./types";

export const hvfStrategy: Strategy = (ctx) => {
  if (ctx.candles.length < 60) return null;
  const hvf = analyzeHVF(ctx.candles);
  if (!hvf) return null;
  if (hvf.direction === "neutral") return null;

  // Build SL/TP using existing planRisk with broker-min padding
  const direction = hvf.direction as "long" | "short";
  const minStopPct = ctx.brokerMinSlPct[direction];
  const plan = planRisk({
    entryPrice: ctx.currentPrice,
    direction,
    atr: hvf.metrics.currentATR,
    recentLow: hvf.metrics.recentLow,
    recentHigh: hvf.metrics.recentHigh,
    minStopPct,
  });

  const conviction: "high" | "medium" | "low" =
    hvf.score >= 75 ? "high" : hvf.score >= 60 ? "medium" : "low";

  return {
    strategy: "hvf",
    symbol: ctx.symbol,
    direction,
    score: Math.round(hvf.score * 10) / 10,
    conviction,
    reason: `HVF ${hvf.score.toFixed(1)} ${direction} — range compression ${hvf.components.rangeCompression}/25, funnel ${hvf.components.funnelStructure}/25, EMA-stack ${hvf.components.trendAlignment}/20`,
    signals: hvf.signals,
    entryPrice: ctx.currentPrice,
    suggestedSL: plan.stopLoss,
    suggestedTP: plan.takeProfit,
    rewardRiskRatio: plan.rewardRiskRatio,
  };
};

// Re-export so callers don't need two imports
export type { StrategyCandidate };
