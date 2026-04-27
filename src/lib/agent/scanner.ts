// Universe scanner — runs HVF analysis across all instruments in
// the curated universe. Returns ranked candidates for the LLM to
// reason about.
import { etoro } from "@/lib/etoro/client";
import { db } from "@/lib/neon";
import { analyzeHVF, type HVFAnalysis, type OHLC } from "./hvf";
import { UNIVERSE, type UniverseEntry } from "./universe";
import { checkMarketHours, type AssetClass } from "./market-hours";

export interface ScanCandidate {
  symbol: string;
  instrumentId: number;
  display: string;
  assetClass: string;
  thesis: string;
  shortAllowed: boolean;
  currentPrice: number;
  hvf: HVFAnalysis;
  marketIsOpen: boolean;
  marketHoursReason: string;
}

/** Resolve symbol → instrumentId via the Neon cache populated by
 *  /api/admin/discover-instruments. The eToro /market-data/search endpoint
 *  is unreliable for crypto/equity discovery, so we don't fall back to it. */
async function resolveInstrument(entry: UniverseEntry): Promise<number | null> {
  if (entry.instrumentId) return entry.instrumentId;

  const sql = db();
  const cached = await sql`
    SELECT instrument_id FROM instruments WHERE symbol = ${entry.symbol} LIMIT 1
  ` as unknown as { instrument_id: number }[];
  if (cached.length > 0) return Number(cached[0].instrument_id);

  console.warn(`[scanner] No instrument ID cached for ${entry.symbol}. Run /api/admin/discover-instruments to refresh the cache.`);
  return null;
}

export type CandlePeriod =
  | "OneMinute"
  | "FiveMinutes"
  | "TenMinutes"
  | "FifteenMinutes"
  | "ThirtyMinutes"
  | "OneHour"
  | "FourHours"
  | "OneDay"
  | "OneWeek";

const TIMEFRAME_TO_ETORO: Record<string, CandlePeriod> = {
  "1m": "OneMinute",
  "5m": "FiveMinutes",
  "10m": "TenMinutes",
  "15m": "FifteenMinutes",
  "30m": "ThirtyMinutes",
  "1h": "OneHour",
  "4h": "FourHours",
  "1d": "OneDay",
  "1w": "OneWeek",
};

async function getCandlesFor(instrumentId: number, period: CandlePeriod = "OneDay", count = 250): Promise<OHLC[]> {
  const candles = await etoro.getCandles(instrumentId, period, count);
  return candles.map((c) => ({
    time: Math.floor(new Date(c.fromDate).getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

export interface ScanOptions {
  /** Override the universe — defaults to the strategic universe */
  universe?: UniverseEntry[];
  /** Candle timeframe — defaults to "1d" for strategic */
  timeframe?: keyof typeof TIMEFRAME_TO_ETORO;
  /** Number of candles to fetch */
  candleCount?: number;
}

/**
 * Scan the universe in parallel, return candidates sorted by HVF score desc.
 * Skips instruments that fail to resolve or have insufficient data.
 */
export async function scanUniverse(opts: ScanOptions = {}): Promise<ScanCandidate[]> {
  const universe = opts.universe || UNIVERSE;
  const period = TIMEFRAME_TO_ETORO[opts.timeframe || "1d"] || "OneDay";
  const candleCount = opts.candleCount || 250;
  const tasks = universe.map(async (entry): Promise<ScanCandidate | null> => {
    try {
      const instrumentId = await resolveInstrument(entry);
      if (!instrumentId) return null;

      const [candles, rates] = await Promise.all([
        getCandlesFor(instrumentId, period, candleCount),
        etoro.getRates([instrumentId], "paper"),
      ]);

      if (candles.length < 60) return null;
      const hvf = analyzeHVF(candles);
      if (!hvf) return null;

      const rate = rates[0];
      const currentPrice = rate ? (rate.bid + rate.ask) / 2 : candles[candles.length - 1].close;
      const hours = checkMarketHours(entry.assetClass as AssetClass);

      return {
        symbol: entry.symbol,
        instrumentId,
        display: entry.display,
        assetClass: entry.assetClass,
        thesis: entry.thesis,
        shortAllowed: entry.shortAllowed,
        currentPrice,
        hvf,
        marketIsOpen: hours.isOpen,
        marketHoursReason: hours.reason,
      };
    } catch (e) {
      console.error(`Scan failed for ${entry.symbol}:`, e);
      return null;
    }
  });

  const results = await Promise.all(tasks);
  return results
    .filter((r): r is ScanCandidate => r !== null)
    .sort((a, b) => b.hvf.score - a.hvf.score);
}
