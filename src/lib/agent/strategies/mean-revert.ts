// Mean Reversion strategy — catches snap-back bounces from extreme levels.
//
// Long entry conditions:
//   1. RSI(14) < 25 (deeply oversold)
//   2. Current price within 1% of a recent multi-day low (support level)
//   3. Lower wick on the most recent candle (rejection visible)
//
// Short entry: mirror — RSI > 75 + within 1% of recent high + upper wick.
//
// Target: revert to EMA20 (the local mean). SL: just past the support/resistance
// that we're bouncing from (so a small adverse move means we're wrong).
//
// Best for: oversold/overbought spikes in chop. Worst case: catching falling
// knives if the support fails (SL handles this).
//
// Different from HVF (which wants compression) and trend-break (which wants
// momentum continuation). Mean-revert wants exhaustion + level + wick.

import type { Strategy, StrategyCandidate } from "./types";
import { padSL } from "./types";

const RSI_PERIOD = 14;
const LEVEL_LOOKBACK = 40;             // bars to look back for support/resistance
const LEVEL_PROXIMITY_PCT = 1.0;       // must be within 1% of the level
const RSI_OVERSOLD = 25;
const RSI_OVERBOUGHT = 75;
const WICK_RATIO_MIN = 0.4;            // wick must be at least 40% of total candle range
const TARGET_RR = 1.5;

function rsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function ema(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export const meanRevertStrategy: Strategy = (ctx) => {
  if (ctx.candles.length < LEVEL_LOOKBACK + RSI_PERIOD) return null;
  const candles = ctx.candles;
  const last = candles[candles.length - 1];
  const close = last.close;
  const closes = candles.map((c) => c.close);

  // RSI exhaustion check
  const rsiVal = rsi(closes, RSI_PERIOD);

  // Find recent multi-day support / resistance
  const lookback = candles.slice(-LEVEL_LOOKBACK);
  const support = Math.min(...lookback.map((c) => c.low));
  const resistance = Math.max(...lookback.map((c) => c.high));
  const distToSupportPct = ((close - support) / close) * 100;
  const distToResistancePct = ((resistance - close) / close) * 100;

  // Wick analysis — rejection candle?
  const range = last.high - last.low;
  if (range === 0) return null;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const lowerWickRatio = lowerWick / range;
  const upperWickRatio = upperWick / range;

  let direction: "long" | "short" | null = null;
  let levelPrice = 0;
  let wickRatio = 0;

  if (rsiVal < RSI_OVERSOLD && distToSupportPct < LEVEL_PROXIMITY_PCT && lowerWickRatio >= WICK_RATIO_MIN) {
    direction = "long";
    levelPrice = support;
    wickRatio = lowerWickRatio;
  } else if (rsiVal > RSI_OVERBOUGHT && distToResistancePct < LEVEL_PROXIMITY_PCT && upperWickRatio >= WICK_RATIO_MIN) {
    direction = "short";
    levelPrice = resistance;
    wickRatio = upperWickRatio;
  } else {
    return null;
  }

  // SL just past the support/resistance level
  const slBuffer = (resistance - support) * 0.05; // 5% of recent range as buffer
  let stopLoss = direction === "long"
    ? support - slBuffer
    : resistance + slBuffer;

  // Pad to broker minimum
  const minStopPct = ctx.brokerMinSlPct[direction];
  stopLoss = padSL(close, stopLoss, direction, minStopPct);

  // TP: revert to EMA20 (the local mean), or 1.5R, whichever is closer
  const ema20 = ema(closes, 20);
  const risk = Math.abs(close - stopLoss);
  const tpByEma = ema20;
  const tpByRR = direction === "long" ? close + risk * TARGET_RR : close - risk * TARGET_RR;
  const takeProfit = direction === "long"
    ? Math.min(tpByEma, tpByRR)
    : Math.max(tpByEma, tpByRR);

  const reward = Math.abs(takeProfit - close);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < 1.0) return null; // mean-revert needs at least 1R

  // Score 0-100:
  //  +30 for RSI extremity (further from 50 = better)
  //  +30 for level proximity (closer to support/resistance = better)
  //  +25 for wick strength
  //  +15 base
  const rsiScore = direction === "long"
    ? Math.min(30, (RSI_OVERSOLD - rsiVal) * 3)
    : Math.min(30, (rsiVal - RSI_OVERBOUGHT) * 3);
  const proximityScore = Math.max(0, 30 - (direction === "long" ? distToSupportPct : distToResistancePct) * 30);
  const wickScore = Math.min(25, wickRatio * 50);
  const score = Math.round(rsiScore + proximityScore + wickScore + 15);

  const conviction: "high" | "medium" | "low" =
    score >= 75 ? "high" : score >= 55 ? "medium" : "low";

  const signals = [
    `RSI(14) ${rsiVal.toFixed(1)} (${direction === "long" ? "oversold <25" : "overbought >75"})`,
    `Within ${(direction === "long" ? distToSupportPct : distToResistancePct).toFixed(2)}% of ${LEVEL_LOOKBACK}-bar ${direction === "long" ? "support" : "resistance"} ${levelPrice.toFixed(4)}`,
    `${direction === "long" ? "Lower" : "Upper"} wick is ${(wickRatio * 100).toFixed(0)}% of candle range (rejection)`,
  ];

  return {
    strategy: "mean_revert",
    symbol: ctx.symbol,
    direction,
    score,
    conviction,
    reason: `Mean-revert ${direction}: RSI ${rsiVal.toFixed(0)} at multi-day ${direction === "long" ? "support" : "resistance"} with ${direction === "long" ? "lower" : "upper"} wick rejection. Target the mean (EMA20).`,
    signals,
    entryPrice: close,
    suggestedSL: Number(stopLoss.toFixed(6)),
    suggestedTP: Number(takeProfit.toFixed(6)),
    rewardRiskRatio: Number(rr.toFixed(2)),
  };
};

export type { StrategyCandidate };
