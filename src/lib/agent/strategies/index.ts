// Strategy registry — declares which strategies are enabled per environment.
//
// Real money: HVF only (Francis discipline, proven setup).
// Paper / Binance: full suite — HVF + trend-break + mean-revert + multi-TF HVF.
// This is the "creative learning lab" the user requested: try everything on
// paper, only graduate proven strategies to real.
//
// Each strategy is a pure function (StrategyContext → StrategyCandidate | null).
// The scanner runs every enabled strategy for the env and aggregates results.

import { hvfStrategy } from "./hvf";
import { trendBreakStrategy } from "./trend-break";
import { meanRevertStrategy } from "./mean-revert";
import { hvfMultiTfStrategy } from "./hvf-multi-tf";
import type { Strategy, StrategyName } from "./types";

export type StrategyEnv = "paper" | "real" | "binance";

const REGISTRY: Record<StrategyName, Strategy> = {
  hvf: hvfStrategy,
  trend_break: trendBreakStrategy,
  mean_revert: meanRevertStrategy,
  hvf_mtf: hvfMultiTfStrategy,
};

const ENABLED_BY_ENV: Record<StrategyEnv, StrategyName[]> = {
  // Real money: only the proven HVF setup. No experimentation here.
  real: ["hvf"],
  // Paper: the creative learning lab. Run everything.
  paper: ["hvf", "trend_break", "mean_revert", "hvf_mtf"],
  // Binance: spot only, same creative posture as paper.
  binance: ["hvf", "trend_break", "mean_revert", "hvf_mtf"],
};

export function strategiesFor(env: StrategyEnv): Strategy[] {
  return ENABLED_BY_ENV[env].map((name) => REGISTRY[name]);
}

export function strategyNamesFor(env: StrategyEnv): StrategyName[] {
  return [...ENABLED_BY_ENV[env]];
}

export { REGISTRY };
export * from "./types";
