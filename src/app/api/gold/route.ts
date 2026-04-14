import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  // Try Binance XAUUSDT first
  const binanceSources = [
    "https://api.binance.com/api/v3/klines?symbol=XAUUSDT&interval=1d&limit=365",
    "https://api.binance.us/api/v3/klines?symbol=XAUUSDT&interval=1d&limit=365",
  ];

  for (const url of binanceSources) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "TradingDashboard/1.0" },
        cache: "no-store",
      });

      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;

      // Validate freshness
      if (data.length > 0) {
        const newestTs = Number(data[data.length - 1][0]);
        if (newestTs < Date.now() - 7 * 24 * 60 * 60 * 1000) continue;
      }

      const candles = data.map((d: (string | number)[]) => ({
        time: Math.floor(Number(d[0]) / 1000),
        open: parseFloat(String(d[1])),
        high: parseFloat(String(d[2])),
        low: parseFloat(String(d[3])),
        close: parseFloat(String(d[4])),
      }));

      return NextResponse.json(candles);
    } catch {
      continue;
    }
  }

  // Fallback: CoinGecko gold market chart (better than OHLC for gold)
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/tether-gold/ohlc?vs_currency=usd&days=90",
      { cache: "no-store" }
    );

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const candles = data.map((d: number[]) => ({
          time: Math.floor(d[0] / 1000),
          open: d[1],
          high: d[2],
          low: d[3],
          close: d[4],
        }));
        return NextResponse.json(candles);
      }
    }
  } catch {
    // fall through
  }

  // Fallback 2: Use gold market_chart from CoinGecko and synthesize candles
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/tether-gold/market_chart?vs_currency=usd&days=180&interval=daily",
      { cache: "no-store" }
    );

    if (res.ok) {
      const data = await res.json();
      if (data.prices && Array.isArray(data.prices) && data.prices.length > 0) {
        const candles = data.prices.map((point: [number, number]) => ({
          time: Math.floor(point[0] / 1000),
          open: point[1],
          high: point[1] * 1.002,
          low: point[1] * 0.998,
          close: point[1],
        }));
        return NextResponse.json(candles);
      }
    }
  } catch {
    // fall through
  }

  return NextResponse.json({ error: "All gold data sources failed" }, { status: 502 });
}
