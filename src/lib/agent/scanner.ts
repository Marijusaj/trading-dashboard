// Universe scanner — runs HVF analysis across all instruments in
// the curated universe. Returns ranked candidates for the LLM to
// reason about.
import { etoro } from "@/lib/etoro/client";
import { db } from "@/lib/neon";
import { analyzeHVF, type HVFAnalysis, type OHLC } from "./hvf";
import { UNIVERSE, type UniverseEntry } from "./universe";

export interface ScanCandidate {
  symbol: string;
  instrumentId: number;
  display: string;
  assetClass: string;
  thesis: string;
  shortAllowed: boolean;
  currentPrice: number;
  hvf: HVFAnalysis;
}

/** Resolve symbol → instrumentId, caching in Neon. */
async function resolveInstrument(entry: UniverseEntry): Promise<number | null> {
  if (entry.instrumentId) return entry.instrumentId;

  const sql = db();
  // Check cache
  const cached = await sql`
    SELECT instrument_id FROM instruments WHERE symbol = ${entry.symbol} LIMIT 1
  ` as unknown as { instrument_id: number }[];
  if (cached.length > 0) return Number(cached[0].instrument_id);

  // Search via eToro
  try {
    const results = await etoro.searchInstruments(entry.symbol);
    const exact = results.find(
      (r) => r.internalSymbolFull?.toUpperCase() === entry.symbol.toUpperCase(),
    ) || results[0];
    if (!exact) return null;

    await sql`
      INSERT INTO instruments (instrument_id, symbol, name, asset_class, metadata)
      VALUES (
        ${exact.instrumentID},
        ${entry.symbol},
        ${exact.instrumentDisplayName || entry.display},
        ${entry.assetClass},
        ${JSON.stringify(exact)}::jsonb
      )
      ON CONFLICT (instrument_id) DO UPDATE
        SET refreshed_at = now(),
            metadata     = EXCLUDED.metadata
    `;
    return exact.instrumentID;
  } catch (e) {
    console.error(`Failed to resolve ${entry.symbol}:`, e);
    return null;
  }
}

/** Pull eToro daily candles and convert to our OHLC shape. */
async function getCandlesFor(instrumentId: number): Promise<OHLC[]> {
  const candles = await etoro.getCandles(instrumentId, "OneDay", 250);
  return candles.map((c) => ({
    time: Math.floor(new Date(c.fromDate).getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

/**
 * Scan the universe in parallel, return candidates sorted by HVF score desc.
 * Skips instruments that fail to resolve or have insufficient data.
 */
export async function scanUniverse(): Promise<ScanCandidate[]> {
  const tasks = UNIVERSE.map(async (entry): Promise<ScanCandidate | null> => {
    try {
      const instrumentId = await resolveInstrument(entry);
      if (!instrumentId) return null;

      const [candles, rates] = await Promise.all([
        getCandlesFor(instrumentId),
        etoro.getRates([instrumentId]),
      ]);

      if (candles.length < 60) return null;
      const hvf = analyzeHVF(candles);
      if (!hvf) return null;

      const rate = rates[0];
      const currentPrice = rate ? (rate.bid + rate.ask) / 2 : candles[candles.length - 1].close;

      return {
        symbol: entry.symbol,
        instrumentId,
        display: entry.display,
        assetClass: entry.assetClass,
        thesis: entry.thesis,
        shortAllowed: entry.shortAllowed,
        currentPrice,
        hvf,
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
