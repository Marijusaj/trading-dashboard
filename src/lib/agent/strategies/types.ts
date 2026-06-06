// Shared types for the strategy module system.
//
// Each strategy is a pure function: given price history + context,
// returns at most one trade candidate (or null if no setup).
// The scanner runs all enabled strategies per asset and aggregates
// candidates for the agent to reason across.

import type { OHLC } from "../hvf";

export type StrategyName = "hvf" | "trend_break" | "mean_revert" | "hvf_mtf";

// Mirrors market-hours.AssetClass so the scanner can pass values through
// without coercion. Strategies only need the broker-min lookup; classes we
// don't actively trade (fx, index) fall back to "equity"-like minimums.
export type AssetClass = "crypto" | "commodity" | "equity" | "etf" | "fx" | "index";

export interface StrategyContext {
  symbol: string;
  /** Chronological order, oldest first */
  candles: OHLC[];
  currentPrice: number;
  assetClass: AssetClass;
  /** Per-direction broker minimum stop pct — strategies should
   *  already produce broker-safe SL. */
  brokerMinSlPct: { long: number; short: number };
}

export interface StrategyCandidate {
  strategy: StrategyName;
  symbol: string;
  direction: "long" | "short";
  /** 0-100 score in the strategy's own scoring system. NOT comparable
   *  across strategies — each one has its own meaning. */
  score: number;
  conviction: "high" | "medium" | "low";
  /** Human-readable why */
  reason: string;
  /** Bullet-list of contributing signals */
  signals: string[];
  /** Suggested entry (usually currentPrice for market orders) */
  entryPrice: number;
  /** Pre-padded for broker minimum — agent should not tighten */
  suggestedSL: number;
  suggestedTP: number;
  /** Computed for convenience */
  rewardRiskRatio: number;
}

export type Strategy = (ctx: StrategyContext) => StrategyCandidate | null;

/**
 * Broker-floor stop minimums by asset class + direction.
 * Mirrors guardrails.MIN_SL_DISTANCE_PCT — keep in sync.
 */
export const BROKER_MIN_SL_PCT: Record<AssetClass, { long: number; short: number }> = {
  crypto:    { long: 1.5, short: 5.5 },
  commodity: { long: 2.5, short: 2.5 },
  equity:    { long: 1.5, short: 1.5 },
  etf:       { long: 1.5, short: 1.5 },
  fx:        { long: 1.5, short: 1.5 },
  index:     { long: 1.5, short: 1.5 },
};

/** Pad an SL outward to broker minimum if needed. */
export function padSL(entry: number, sl: number, direction: "long" | "short", minPct: number): number {
  if (direction === "long") {
    const brokerFloor = entry * (1 - minPct / 100);
    return Math.min(sl, brokerFloor); // further from entry (lower) = min
  } else {
    const brokerFloor = entry * (1 + minPct / 100);
    return Math.max(sl, brokerFloor); // further from entry (higher) = max
  }
}

/** Compute TP from SL to achieve a given R:R. */
export function tpFromRR(entry: number, sl: number, direction: "long" | "short", rr: number): number {
  const risk = Math.abs(entry - sl);
  return direction === "long" ? entry + risk * rr : entry - risk * rr;
}
