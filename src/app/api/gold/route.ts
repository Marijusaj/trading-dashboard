import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const interval = searchParams.get("interval") || "1d";
  const limit = searchParams.get("limit") || "365";

  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=XAUUSDT&interval=${interval}&limit=${limit}`
    );
    const data = await res.json();

    const candles = data.map((d: (string | number)[]) => ({
      time: Math.floor(Number(d[0]) / 1000),
      open: parseFloat(String(d[1])),
      high: parseFloat(String(d[2])),
      low: parseFloat(String(d[3])),
      close: parseFloat(String(d[4])),
    }));

    return NextResponse.json(candles);
  } catch (e) {
    console.error("Gold API error:", e);
    return NextResponse.json({ error: "Failed to fetch gold data" }, { status: 500 });
  }
}
