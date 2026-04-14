import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Map symbols to CoinGecko IDs
const GECKO_MAP: Record<string, string> = {
  btc: "bitcoin",
  trx: "tron",
  eth: "ethereum",
  sol: "solana",
  xrp: "ripple",
  bnb: "binancecoin",
};

function parseGeckoId(symbol: string): { geckoId: string; vsCurrency: string } {
  // TRXBTC → base=TRX, quote=BTC
  // BTCUSDT → base=BTC, quote=USDT
  // TRXUSDT → base=TRX, quote=USDT
  const isPairBtc = symbol.endsWith("BTC") && symbol !== "BTC";
  const raw = symbol
    .replace(/USDT$/i, "")
    .replace(/USDC$/i, "")
    .replace(/BTC$/i, "")
    .toLowerCase();

  // For "BTCUSDT", raw becomes "" after stripping — handle explicitly
  const base = raw || "btc";
  return {
    geckoId: GECKO_MAP[base] || base,
    vsCurrency: isPairBtc ? "btc" : "usd",
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get("symbol") || "BTCUSDT";
  const interval = searchParams.get("interval") || "1d";
  const limit = searchParams.get("limit") || "200";

  // ── Source 1: Binance Global (skip Binance US — returns stale data for delisted pairs)
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "TradingDashboard/1.0" },
      cache: "no-store",
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const newestTs = Number(data[data.length - 1][0]);
        if (newestTs > Date.now() - 7 * 24 * 60 * 60 * 1000) {
          const candles = data.map((d: (string | number)[]) => ({
            time: Math.floor(Number(d[0]) / 1000),
            open: parseFloat(String(d[1])),
            high: parseFloat(String(d[2])),
            low: parseFloat(String(d[3])),
            close: parseFloat(String(d[4])),
            volume: parseFloat(String(d[5])),
          }));
          return NextResponse.json(candles);
        }
      }
    }
  } catch {
    // Binance blocked on this IP — fall through
  }

  // ── Source 2: CoinGecko OHLC
  const { geckoId, vsCurrency } = parseGeckoId(symbol);
  const days = interval === "1d" ? 90 : interval === "4h" ? 30 : 7;

  try {
    const url = `https://api.coingecko.com/api/v3/coins/${geckoId}/ohlc?vs_currency=${vsCurrency}&days=${days}`;
    const res = await fetch(url, { cache: "no-store" });

    if (res.ok) {
      const data = await res.json();
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
  } catch {
    // CoinGecko OHLC failed — try market_chart
  }

  // ── Source 3: CoinGecko market_chart (synthesize candles from daily prices)
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=${vsCurrency}&days=${days}&interval=daily`;
    const res = await fetch(url, { cache: "no-store" });

    if (res.ok) {
      const data = await res.json();
      if (data.prices && Array.isArray(data.prices) && data.prices.length > 1) {
        // Group consecutive price points into daily candles
        const candles = data.prices.map((point: [number, number], i: number) => {
          const price = point[1];
          const prevPrice = i > 0 ? data.prices[i - 1][1] : price;
          return {
            time: Math.floor(point[0] / 1000),
            open: prevPrice,
            high: Math.max(price, prevPrice) * 1.001,
            low: Math.min(price, prevPrice) * 0.999,
            close: price,
            volume: 0,
          };
        });
        return NextResponse.json(candles);
      }
    }
  } catch {
    // market_chart also failed
  }

  // ── Source 4: CryptoCompare (another free API)
  try {
    const fsym = symbol.replace(/USDT$/i, "").replace(/USDC$/i, "").replace(/BTC$/i, "").toUpperCase() || "BTC";
    const tsym = symbol.endsWith("BTC") ? "BTC" : "USD";
    const ccLimit = Math.min(parseInt(limit), 100);
    const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${fsym}&tsym=${tsym}&limit=${ccLimit}`;
    const res = await fetch(url, { cache: "no-store" });

    if (res.ok) {
      const json = await res.json();
      if (json.Data?.Data && Array.isArray(json.Data.Data)) {
        const candles = json.Data.Data.map((d: { time: number; open: number; high: number; low: number; close: number; volumeto: number }) => ({
          time: d.time,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volumeto || 0,
        }));
        return NextResponse.json(candles);
      }
    }
  } catch {
    // CryptoCompare also failed
  }

  return NextResponse.json({ error: "All data sources failed" }, { status: 502 });
}
