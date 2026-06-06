// Trend-Break / Momentum strategy — catches the "BTC freefall" pattern
// that HVF skips by design (HVF wants compression, not trending moves).
//
// Long entry conditions (all must be true):
//   1. Current close > highest close of last N bars (default N=20)
//   2. ATR(14) is expanding vs ATR(60) — momentum confirmation
//   3. Price above EMA200 (trend confirmation)
//
// Short entry: mirror of above (close < N-bar low, ATR expanding, below EMA200).
//
// Why this catches freefalls:
//   - When BTC breaks support, the close goes below 20-bar low
//   - ATR expands as volatility increases
//   - Price below EMA200 confirms downtrend
//   → entry on the breakdown, not on the prior coil
//
// Scoring 0-100 reflects: how clean the break + how expanded ATR + how
// far below/above EMA200 (trend strength).

import type { Strategy, StrategyCandidate } from "./types";
import { padSL, tpFromRR } from "./types";

const LOOKBACK_BARS = 20;        // N-bar high/low break
const ATR_PERIOD = 14;
const HIST_ATR_PERIOD = 60;
const EMA_TREND_PERIOD = 200;
const ATR_EXPANSION_MIN = 1.15;  // current ATR must be 15%+ above historic
const TARGET_RR = 2.0;           // momentum trades target 2R minimum

function atr(candles: { high: number; low: number; close: number }[], period: number): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    );
    sum += tr;
  }
  return sum / period;
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

export const trendBreakStrategy: Strategy = (ctx) => {
  if (ctx.candles.length < EMA_TREND_PERIOD + 5) return null;
  const candles = ctx.candles;
  const last = candles[candles.length - 1];
  const close = last.close;

  // N-bar high/low (exclude current bar from comparison)
  const lookback = candles.slice(-LOOKBACK_BARS - 1, -1);
  const nBarHigh = Math.max(...lookback.map((c) => c.high));
  const nBarLow = Math.min(...lookback.map((c) => c.low));

  // ATR expansion check
  const currentATR = atr(candles, ATR_PERIOD);
  const histATR = atr(candles, HIST_ATR_PERIOD);
  const atrRatio = histATR > 0 ? currentATR / histATR : 1;
  if (atrRatio < ATR_EXPANSION_MIN) return null; // no momentum

  // EMA200 trend filter
  const closes = candles.map((c) => c.close);
  const ema200 = ema(closes, EMA_TREND_PERIOD);
  const distFromEma = ((close - ema200) / ema200) * 100;

  let direction: "long" | "short" | null = null;
  if (close > nBarHigh && close > ema200) direction = "long";
  else if (close < nBarLow && close < ema200) direction = "short";
  if (!direction) return null;

  // SL: prior swing or 2×ATR, whichever is closer to entry
  const swingSL = direction === "long" ? nBarLow : nBarHigh;
  const atrSL = direction === "long" ? close - currentATR * 2 : close + currentATR * 2;
  let stopLoss = direction === "long" ? Math.max(swingSL, atrSL) : Math.min(swingSL, atrSL);

  // Pad to broker minimum
  const minStopPct = ctx.brokerMinSlPct[direction];
  stopLoss = padSL(close, stopLoss, direction, minStopPct);

  const takeProfit = tpFromRR(close, stopLoss, direction, TARGET_RR);
  const risk = Math.abs(close - stopLoss);
  const reward = Math.abs(takeProfit - close);
  const rr = risk > 0 ? reward / risk : 0;

  // Score 0-100:
  //  +30 for clean break (close >5% past level)
  //  +30 for ATR expansion ratio
  //  +20 for distance from EMA200
  //  +20 base (all conditions met)
  const breakDistancePct = direction === "long"
    ? ((close - nBarHigh) / nBarHigh) * 100
    : ((nBarLow - close) / nBarLow) * 100;
  const breakScore = Math.min(30, breakDistancePct * 6);              // 5%+ break = max
  const atrScore = Math.min(30, (atrRatio - 1) * 100);                 // 30% expansion = max
  const trendScore = Math.min(20, Math.abs(distFromEma) * 1);          // 20% away = max
  const baseScore = 20;
  const score = Math.round(breakScore + atrScore + trendScore + baseScore);

  const conviction: "high" | "medium" | "low" =
    score >= 75 ? "high" : score >= 55 ? "medium" : "low";

  const signals = [
    `Close ${close.toFixed(4)} ${direction === "long" ? "broke above" : "broke below"} ${LOOKBACK_BARS}-bar ${direction === "long" ? "high" : "low"} ${(direction === "long" ? nBarHigh : nBarLow).toFixed(4)} by ${breakDistancePct.toFixed(2)}%`,
    `ATR expanding: current ${currentATR.toFixed(4)} vs historic ${histATR.toFixed(4)} (ratio ${atrRatio.toFixed(2)}x)`,
    `${direction === "long" ? "Above" : "Below"} EMA200 ${ema200.toFixed(4)} by ${Math.abs(distFromEma).toFixed(2)}%`,
  ];

  return {
    strategy: "trend_break",
    symbol: ctx.symbol,
    direction,
    score,
    conviction,
    reason: `Momentum break ${direction}: closed past ${LOOKBACK_BARS}-bar ${direction === "long" ? "high" : "low"} with ${atrRatio.toFixed(2)}x ATR expansion. Entry on breakdown, not the prior coil.`,
    signals,
    entryPrice: close,
    suggestedSL: Number(stopLoss.toFixed(6)),
    suggestedTP: Number(takeProfit.toFixed(6)),
    rewardRiskRatio: Number(rr.toFixed(2)),
  };
};

export type { StrategyCandidate };
