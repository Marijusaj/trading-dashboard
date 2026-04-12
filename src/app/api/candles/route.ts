import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get("symbol") || "BTCUSDT";
  const interval = searchParams.get("interval") || "1d";
  const limit = searchParams.get("limit") || "200";

  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    const data = await res.json();

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
    console.error("Candles API error:", e);
    return NextResponse.json({ error: "Failed to fetch candles" }, { status: 500 });
  }
}
