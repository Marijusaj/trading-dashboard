import { NextResponse } from "next/server";

export async function GET() {
  try {
    const [cryptoRes, goldRes] = await Promise.all([
      fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tron&vs_currencies=usd&include_24hr_change=true&include_market_cap=true",
        { next: { revalidate: 15 } }
      ),
      fetch("https://api.binance.com/api/v3/ticker/price?symbol=XAUUSDT").catch(
        () => null
      ),
    ]);

    const crypto = await cryptoRes.json();
    let goldPrice = 4746;
    if (goldRes?.ok) {
      const goldData = await goldRes.json();
      goldPrice = parseFloat(goldData.price);
    }

    return NextResponse.json({
      btc: crypto?.bitcoin?.usd || 71000,
      trx: crypto?.tron?.usd || 0.322,
      gold: goldPrice,
      btc24hChange: crypto?.bitcoin?.usd_24h_change || 0,
      trx24hChange: crypto?.tron?.usd_24h_change || 0,
      btcMarketCap: crypto?.bitcoin?.usd_market_cap || 0,
      trxMarketCap: crypto?.tron?.usd_market_cap || 0,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.error("Price API error:", e);
    return NextResponse.json({ error: "Failed to fetch prices" }, { status: 500 });
  }
}
