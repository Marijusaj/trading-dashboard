// HVF strategy — Francis Hunt's Hunt Volatility Funnel, computed from the candles.
// A candidate exists only when a real funnel (1H/1L..3H/3L) has triggered and
// price is still near its entry. Levels come from the funnel's geometry:
// stop = 3L (3H for inverted, or the primer's), target = AMP1 from the midway line.
// See hvf-funnel.ts and docs/hvf-spec.md.

import { analyzeHvfFunnels, actionableSetup } from "../hvf-funnel";
import { padSL, type Strategy, type StrategyCandidate } from "./types";

export const hvfStrategy: Strategy = (ctx) => {
  const analysis = analyzeHvfFunnels(ctx.candles);
  const setup = actionableSetup(analysis, ctx.currentPrice);
  if (!setup) return null;

  const f = setup.funnel;
  const direction = setup.direction;
  const stop = padSL(ctx.currentPrice, setup.stop, direction, ctx.brokerMinSlPct[direction]);
  const risk = Math.abs(ctx.currentPrice - stop);
  const rr = risk > 0 ? Math.abs(setup.target - ctx.currentPrice) / risk : 0;
  if (rr < 1.5) return null; // broker padding ate the edge

  const conviction: "high" | "medium" | "low" = f.score >= 70 ? "high" : f.score >= 50 ? "medium" : "low";
  const p = f.points;
  return {
    strategy: "hvf",
    symbol: ctx.symbol,
    direction,
    score: f.score,
    conviction,
    reason:
      `HVF ${direction} ${setup.via === "primer" ? "via primer" : "triggered"} — ` +
      `1H ${p.h1.price} 1L ${p.l1.price} 3H ${p.h3.price} 3L ${p.l3.price}; ` +
      `target ${f.levels.target} (AMP1 from midway), R:R ${rr.toFixed(2)} from current`,
    signals: [
      ...f.notes,
      f.trigger?.volumeRatio != null ? `trigger-bar volume ${f.trigger.volumeRatio}× average` : "no volume data on trigger bar",
      f.volume ? `path to target through voids: ${(f.volume.voidPathShare * 100).toFixed(0)}%` : "no volume profile",
    ],
    entryPrice: ctx.currentPrice,
    suggestedSL: Number(stop.toPrecision(6)),
    suggestedTP: f.levels.target,
    rewardRiskRatio: Number(rr.toFixed(2)),
  } satisfies StrategyCandidate;
};

export type { StrategyCandidate };
