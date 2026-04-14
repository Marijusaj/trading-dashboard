import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic"; // Never cache this route on Vercel

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get("symbol") || "BTCUSDT";
  const interval = searchParams.get("interval") || "1d";
  const limit = searchParams.get("limit") || "200";

  // Try Binance first, then fallback to Binance US, then CoinGecko
  const sources = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "TradingDashboard/1.0",
        },
        cache: "no-store",
      });

      if (!res.ok) {
        console.error(`Candles API ${url} returned ${res.status}`);
        continue;
      }

      const data = await res.json();

      // Binance error response is an object, not an array
      if (!Array.isArray(data)) {
        console.error(`Candles API ${url} returned non-array:`, data);
        continue;
      }

      // Validate data is recent — reject if newest candle is older than 7 days
      if (data.length > 0) {
        const newestTs = Number(data[data.length - 1][0]);
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (newestTs < sevenDaysAgo) {
          console.error(`Candles API ${url} returned stale data (newest: ${new Date(newestTs).toISOString()})`);
          continue;
        }
      }

      const candles = data.map((d: (string | number)[]) => ({
        time: Math.floor(Number(d[0]) / 1000),
        open: parseFloat(String(d[1])),
        high: parseFloat(String(d[2])),
        low: parseFloat(String(d[3])),
        close: parseFloat(String(d[4])),
        volume: parseFloat(String(d[5])),
      }));

      return NextResponse.json(candles);
    } catch (e) {
      console.error(`Candles source failed (${url}):`, e);
      continue;
    }
  }

  // Fallback: CoinGecko OHLC (works everywhere, no API key needed)
  try {
    const coinId = symbol.replace("USDT", "").replace("USDC", "").replace("BTC", "").toLowerCase();
    const coinMap: Record<string, string> = {
      btc: "bitcoin", trx: "tron", eth: "ethereum",
      sol: "solana", xrp: "ripple", bnb: "binancecoin",
    };

    // Handle pair charts (TRXBTC) — use base coin
    const base = symbol.replace("USDT", "").replace("BTC", "").toLowerCase();
    const geckoId = coinMap[base] || coinMap[coinId] || base;

    // CoinGecko OHLC: days=90 gives 4-day candles, days=30 gives 4h candles
    const days = interval === "1d" ? 90 : interval === "4h" ? 30 : 7;
    const vsCurrency = symbol.endsWith("BTC") ? "btc" : "usd";

    const geckoRes = await fetch(
      `https://api.coingecko.com/api/v3/coins/${geckoId}/ohlc?vs_currency=${vsCurrency}&days=${days}`,
      { cache: "no-store" }
    );

    if (geckoRes.ok) {
      const data = await geckoRes.json();
      if (Array.isArray(data) && data.length > 0) {
        const candles = data.map((d: number[]) => ({
          time: Math.floor(d[0] / 1000),
          open: d[1],
          high: d[2],
          low: d[3],
          close: d[4],
          volume: 0,
        }));
        return NextResponse.json(candles);
      }
    }
  } catch (e) {
    console.error("CoinGecko fallback failed:", e);
  }

  return NextResponse.json({ error: "All data sources failed" }, { status: 502 });
}
