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

export interface BinanceScanOptions {
  universe?: UniverseEntry[];
  /** Candle timeframe — Binance interval string. Default "1d" for strategic. */
  timeframe?: BinanceInterval;
  candleCount?: number;
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
      }));
      const hvf = analyzeHVF(ohlc);
      if (!hvf) return null;

      const currentPrice = klines[klines.length - 1].close;

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
