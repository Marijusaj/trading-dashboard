// One-shot endpoint: paginate eToro /market-data/instruments,
// resolve our universe symbols to their instrument IDs, and write
// the cache to the Neon `instruments` table.
//
// Run with:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     https://<domain>/api/admin/discover-instruments
//
// Idempotent — uses ON CONFLICT DO UPDATE.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/neon";
import { etoro, type InstrumentMeta } from "@/lib/etoro/client";
import { UNIVERSE } from "@/lib/agent/universe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// eToro instrumentTypeID → our asset_class label
function classifyInstrument(typeId: number): string {
  // 1 = Currency (forex), 5 = Indices, 6 = Commodities, 7 = ETFs (best-effort),
  // 10 = Crypto, 11 = Stocks. Numbers vary; we map known + fall back.
  switch (typeId) {
    case 1: return "fx";
    case 5: return "index";
    case 6: return "commodity";
    case 10: return "crypto";
    case 11: return "equity";
    default: return "other";
  }
}

/** Universe alias map — what eToro's symbolFull or instrumentDisplayName
 *  looks like for each of our universe symbols. eToro often suffixes
 *  crypto with USD or uses spelled-out names for commodities. */
const UNIVERSE_ALIASES: Record<string, string[]> = {
  BTC:    ["BTC", "BTCUSD", "BITCOIN"],
  ETH:    ["ETH", "ETHUSD", "ETHEREUM"],
  TRX:    ["TRX", "TRXUSD", "TRON"],
  SOL:    ["SOL", "SOLUSD", "SOLANA"],
  XRP:    ["XRP", "XRPUSD", "RIPPLE"],
  BNB:    ["BNB", "BNBUSD", "BINANCE", "BINANCECOIN"],
  ADA:    ["ADA", "ADAUSD", "CARDANO"],
  DOGE:   ["DOGE", "DOGEUSD", "DOGECOIN"],
  AVAX:   ["AVAX", "AVAXUSD", "AVALANCHE"],
  LINK:   ["LINK", "LINKUSD", "CHAINLINK"],
  GOLD:   ["GOLD", "XAUUSD", "GOLD-USD"],
  SILVER: ["SILVER", "XAGUSD", "SILVER-USD"],
  MSTR:   ["MSTR"],
  COIN:   ["COIN"],
  GLD:    ["GLD"],
};

function matchesUniverse(meta: InstrumentMeta, universeSymbol: string): boolean {
  const aliases = UNIVERSE_ALIASES[universeSymbol] || [universeSymbol];
  const hay = [
    meta.symbolFull?.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    meta.instrumentDisplayName?.toUpperCase().replace(/[^A-Z0-9]/g, ""),
  ].filter(Boolean);
  for (const alias of aliases) {
    const needle = alias.toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (const h of hay) {
      if (h === needle) return true;
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = db();

    // Pull just enough of eToro's instrument catalog to find our 15 symbols.
    // listInstruments uses parallel pagination + stopWhen for an early bail.
    const matches: Record<string, { instrumentID: number; symbolFull: string; displayName: string } | null> = {};
    const wanted = new Set(UNIVERSE.map((u) => u.symbol));

    const instruments = await etoro.listInstruments("paper", 500, (items) => {
      // Update matches incrementally; stop when all universe symbols found
      for (const u of UNIVERSE) {
        if (matches[u.symbol]) continue;
        const found = items.find((m) => matchesUniverse(m, u.symbol));
        if (found) {
          matches[u.symbol] = {
            instrumentID: found.instrumentID,
            symbolFull: found.symbolFull,
            displayName: found.instrumentDisplayName,
          };
          wanted.delete(u.symbol);
        }
      }
      return wanted.size === 0;
    });
    const totalSeen = instruments.length;

    // Mark unmatched
    for (const u of UNIVERSE) {
      if (!(u.symbol in matches)) matches[u.symbol] = null;
    }

    // Bulk-write the universe matches in a SINGLE multi-row INSERT
    const rows = Object.entries(matches)
      .filter(([, v]) => v !== null)
      .map(([sym, v]) => {
        const u = UNIVERSE.find((x) => x.symbol === sym)!;
        return {
          id: v!.instrumentID,
          symbol: sym,
          name: v!.displayName || u.display,
          asset_class: u.assetClass,
          metadata: JSON.stringify({ ...v, universeAlias: sym }),
        };
      });

    let upserted = 0;
    if (rows.length > 0) {
      // Build a values clause with placeholders for a single bulk insert.
      // Neon HTTP supports parameterized .query() — we'll use individual
      // upserts but limited to ~15 rows so total time is small (15 round
      // trips at ~50ms = ~750ms — well within budget).
      for (const r of rows) {
        try {
          await sql`
            INSERT INTO instruments (instrument_id, symbol, name, asset_class, metadata)
            VALUES (${r.id}, ${r.symbol}, ${r.name}, ${r.asset_class}, ${r.metadata}::jsonb)
            ON CONFLICT (instrument_id) DO UPDATE
              SET symbol       = EXCLUDED.symbol,
                  name         = EXCLUDED.name,
                  asset_class  = EXCLUDED.asset_class,
                  metadata     = EXCLUDED.metadata,
                  refreshed_at = now()
          `;
          upserted++;
        } catch (e) {
          console.warn("universe upsert failed", r.symbol, e);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      totalInstrumentsFromEtoro: totalSeen,
      universeMatched: rows.length,
      universeMissing: UNIVERSE.length - rows.length,
      upserted,
      universeMatches: matches,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
