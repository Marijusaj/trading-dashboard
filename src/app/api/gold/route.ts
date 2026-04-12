import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const interval = searchParams.get("interval") || "1d";
  const limit = searchParams.get("limit") || "365";

  const sources = [
    `https://api.binance.com/api/v3/klines?symbol=XAUUSDT&interval=${interval}&limit=${limit}`,
    `https://api.binance.us/api/v3/klines?symbol=XAUUSDT&interval=${interval}&limit=${limit}`,
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "TradingDashboard/1.0" },
        next: { revalidate: 60 },
      });

      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data)) continue;

      const candles = data.map((d: (string | number)[]) => ({
        time: Math.floor(Number(d[0]) / 1000),
        open: parseFloat(String(d[1])),
        high: parseFloat(String(d[2])),
        low: parseFloat(String(d[3])),
        close: parseFloat(String(d[4])),
      }));

      return NextResponse.json(candles);
    } catch (e) {
      console.error(`Gold source failed (${url}):`, e);
      continue;
    }
  }

  return NextResponse.json({ error: "All gold data sources failed" }, { status: 502 });
}
