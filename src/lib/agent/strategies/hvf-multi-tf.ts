// Multi-Timeframe HVF Confluence strategy.
//
// Same HVF analyzer, but requires confluence across multiple timeframes.
// Higher conviction filter — produces fewer candidates but each one is
// much more likely to play out (the squeeze must be visible on multiple
// scales).
//
// Trigger: HVF on the primary candle TF clears 65 AND HVF on the same
// candles aggregated 4x (next-larger TF) agrees in direction.
//
// Limitation: we only have one TF of candles per scan in the basic
// scanner. So this strategy resamples the existing candles into a
// higher TF by chunking — 4 daily candles → 1 weekly-ish bar — and
// runs HVF on both. Not as good as truly fetching weekly candles from
// eToro, but a cheap approximation that catches obvious dissonance.
//
// Best for: strategic scans (daily candles → "weekly" confluence).
// Less useful on 15m tactical (the 1h resample is noisy).

import { analyzeHVF, planRisk, type OHLC } from "../hvf";
import type { Strategy, StrategyCandidate } from "./types";

/** Aggregate N consecutive candles into one. */
function aggregate(candles: OHLC[], factor: number): OHLC[] {
  const out: OHLC[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const slice = candles.slice(i, i + factor);
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return out;
}

const PRIMARY_MIN_SCORE = 65;     // baseline HVF threshold
const HTF_FACTOR = 4;              // 4x aggregation (daily → ~weekly, 15m → 1h)
const HTF_MIN_SCORE = 55;          // higher TF needs only moderate HVF for confirmation

export const hvfMultiTfStrategy: Strategy = (ctx) => {
  if (ctx.candles.length < 60 * HTF_FACTOR) return null;

  // Primary timeframe HVF
  const primary = analyzeHVF(ctx.candles);
  if (!primary || primary.direction === "neutral") return null;
  if (primary.score < PRIMARY_MIN_SCORE) return null;

  // Higher timeframe HVF (4x aggregation)
  const htfCandles = aggregate(ctx.candles, HTF_FACTOR);
  if (htfCandles.length < 60) return null;
  const htf = analyzeHVF(htfCandles);
  if (!htf || htf.direction === "neutral") return null;
  if (htf.score < HTF_MIN_SCORE) return null;
  if (htf.direction !== primary.direction) return null; // disagreement → skip

  const direction = primary.direction as "long" | "short";
  const minStopPct = ctx.brokerMinSlPct[direction];
  const plan = planRisk({
    entryPrice: ctx.currentPrice,
    direction,
    atr: primary.metrics.currentATR,
    recentLow: primary.metrics.recentLow,
    recentHigh: primary.metrics.recentHigh,
    minStopPct,
  });

  // Combined score: average of primary + HTF (weighted toward primary)
  const score = Math.round(primary.score * 0.6 + htf.score * 0.4);
  const conviction: "high" | "medium" | "low" = "high"; // by construction — both TFs agree

  const signals = [
    `Primary HVF ${primary.score.toFixed(1)} ${direction} (${primary.signals.length} signals)`,
    `HTF HVF ${htf.score.toFixed(1)} ${direction} — direction CONFIRMED on ${HTF_FACTOR}x larger timeframe`,
    `Combined compression: primary ${primary.components.rangeCompression}/25, HTF ${htf.components.rangeCompression}/25`,
    `Combined funnel: primary ${primary.components.funnelStructure}/25, HTF ${htf.components.funnelStructure}/25`,
  ];

  return {
    strategy: "hvf_mtf",
    symbol: ctx.symbol,
    direction,
    score,
    conviction,
    reason: `Multi-TF HVF confluence ${direction}: primary ${primary.score.toFixed(0)} + HTF ${htf.score.toFixed(0)} both agree. Higher conviction filter — fewer signals, more likely to play out.`,
    signals,
    entryPrice: ctx.currentPrice,
    suggestedSL: plan.stopLoss,
    suggestedTP: plan.takeProfit,
    rewardRiskRatio: plan.rewardRiskRatio,
  };
};

export type { StrategyCandidate };
