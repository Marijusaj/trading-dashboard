// Binance universe scanner — runs HVF analysis using Binance Spot
// candle data instead of eToro candles. Long-only world: shortAllowed
// is forced to false on every candidate.
//
// Skips universe entries that don't have a Binance USDC pair mapping.
import { binance, type BinanceInterval } from "@/lib/binance/client";
import { binanceSymbol } from "@/lib/binance/symbols";
import { analyzeHVF, type OHLC } from "./hvf";
import { UNIVERSE, type UniverseEntry } from "./universe";
import type { ScanCandidate } from "./scanner";
import type { Strategy, StrategyCandidate, StrategyContext } from "./strategies/types";
import { BROKER_MIN_SL_PCT } from "./strategies/types";

export interface BinanceScanOptions {
  universe?: UniverseEntry[];
  /** Candle timeframe — Binance interval string. Default "1d" for strategic. */
  timeframe?: BinanceInterval;
  candleCount?: number;
  /** When provided, each strategy is also run per asset and results are
   *  attached as `strategyCandidates`. Mirrors the eToro scanner. */
  strategies?: Strategy[];
}

/**
 * Scan all universe entries that have a Binance USDC pair, return
 * candidates sorted by HVF score descending.
 */
export async function scanBinanceUniverse(
  opts: BinanceScanOptions = {},
): Promise<ScanCandidate[]> {
  const universe = opts.universe || UNIVERSE;
  const interval: BinanceInterval = opts.timeframe || "1d";
  const candleCount = opts.candleCount || 250;

  const tasks = universe.map(async (entry): Promise<ScanCandidate | null> => {
    try {
      const pair = binanceSymbol(entry.symbol);
      if (!pair) return null; // No Binance USDC pair → skip

      const klines = await binance.klines(pair, interval, candleCount);
      if (klines.length < 60) return null;

      const ohlc: OHLC[] = klines.map((k) => ({
        time: Math.floor(k.openTime / 1000),
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      }));
      const hvf = analyzeHVF(ohlc);
      if (!hvf) return null;

      const currentPrice = klines[klines.length - 1].close;

      // Multi-strategy mode. Binance spot is long-only, so short
      // candidates are dropped regardless of strategy verdict.
      let strategyCandidates: StrategyCandidate[] | undefined;
      if (opts.strategies && opts.strategies.length > 0) {
        const sctx: StrategyContext = {
          symbol: entry.symbol,
          candles: ohlc,
          currentPrice,
          assetClass: "crypto",
          brokerMinSlPct: BROKER_MIN_SL_PCT.crypto,
        };
        strategyCandidates = opts.strategies
          .map((strat) => {
            try {
              return strat(sctx);
            } catch (e) {
              console.error(`[binance-scanner] strategy threw for ${entry.symbol}:`, e);
              return null;
            }
          })
          .filter((c): c is StrategyCandidate => c !== null)
          .filter((c) => c.direction === "long");
      }

      // Binance Spot is long-only and 24/7 (always "market open").
      return {
        symbol: entry.symbol,
        instrumentId: 0,            // Binance uses symbol strings, not numeric IDs
        display: entry.display,
        assetClass: entry.assetClass,
        thesis: entry.thesis,
        shortAllowed: false,        // spot can't short
        currentPrice,
        hvf,
        marketIsOpen: true,
        marketHoursReason: "binance spot 24/7",
        strategyCandidates,
      };
    } catch (e) {
      console.warn(`[binance-scanner] ${entry.symbol} scan failed:`, e instanceof Error ? e.message : e);
      return null;
    }
  });

  const results = await Promise.all(tasks);
  return results
    .filter((r): r is ScanCandidate => r !== null)
    .sort((a, b) => b.hvf.score - a.hvf.score);
}
