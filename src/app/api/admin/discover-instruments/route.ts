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
export const maxDuration = 120;

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

    // 1. Pull every tradeable instrument
    const all = await etoro.listInstruments("paper", 1000);

    // 2. Cache ALL of them in `instruments` (by id) — useful for later
    //    universe expansion. Cap inserts to avoid huge writes; only
    //    materialize rows for crypto / commodity / equity / etf / index.
    let totalCached = 0;
    for (const meta of all) {
      const cls = classifyInstrument(meta.instrumentTypeID);
      if (cls === "fx" || cls === "other") continue;
      try {
        await sql`
          INSERT INTO instruments (instrument_id, symbol, name, asset_class, metadata)
          VALUES (
            ${meta.instrumentID},
            ${meta.symbolFull || ""},
            ${meta.instrumentDisplayName || ""},
            ${cls},
            ${JSON.stringify(meta)}::jsonb
          )
          ON CONFLICT (instrument_id) DO UPDATE
            SET symbol       = EXCLUDED.symbol,
                name         = EXCLUDED.name,
                asset_class  = EXCLUDED.asset_class,
                metadata     = EXCLUDED.metadata,
                refreshed_at = now()
        `;
        totalCached++;
      } catch (e) {
        console.warn("instrument cache insert failed", meta.instrumentID, e);
      }
    }

    // 3. Find best match per universe symbol and write universe-keyed
    //    cache rows so scanner's `WHERE symbol = 'BTC'` lookup works.
    const matches: Record<string, { instrumentID: number; symbolFull: string; displayName: string } | null> = {};
    for (const u of UNIVERSE) {
      const found = all.find((m) => matchesUniverse(m, u.symbol));
      if (found) {
        matches[u.symbol] = {
          instrumentID: found.instrumentID,
          symbolFull: found.symbolFull,
          displayName: found.instrumentDisplayName,
        };
        // Upsert with universe symbol as the key so scanner finds it
        try {
          await sql`
            INSERT INTO instruments (instrument_id, symbol, name, asset_class, metadata)
            VALUES (
              ${found.instrumentID},
              ${u.symbol},
              ${found.instrumentDisplayName || u.display},
              ${u.assetClass},
              ${JSON.stringify({ ...found, universeAlias: u.symbol })}::jsonb
            )
            ON CONFLICT (instrument_id) DO UPDATE
              SET symbol       = EXCLUDED.symbol,
                  name         = EXCLUDED.name,
                  asset_class  = EXCLUDED.asset_class,
                  metadata     = EXCLUDED.metadata,
                  refreshed_at = now()
          `;
        } catch (e) {
          console.warn("universe upsert failed", u.symbol, e);
        }
      } else {
        matches[u.symbol] = null;
      }
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      totalInstrumentsFromEtoro: all.length,
      totalCachedInDb: totalCached,
      universeMatches: matches,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
