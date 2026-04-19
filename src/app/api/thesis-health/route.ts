import { NextResponse } from "next/server";
import { THESIS_CLAIMS } from "@/lib/thesis-claims";

export const dynamic = "force-dynamic";

interface CoinGeckoData {
  market_cap?: { btc?: number };
  market_cap_percentage?: Record<string, number>;
}

interface PriceData {
  bitcoin?: { usd: number; usd_market_cap: number };
  tron?: { usd: number; usd_market_cap: number };
  solana?: { usd: number; usd_market_cap: number };
  ethereum?: { usd: number; usd_market_cap: number };
  tether?: { usd_market_cap: number };
}

export async function GET() {
  try {
    // Fetch all needed data in parallel
    const [pricesRes, globalRes] = await Promise.all([
      fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tron,solana,ethereum,tether&vs_currencies=usd&include_market_cap=true",
        { cache: "no-store" }
      ),
      fetch("https://api.coingecko.com/api/v3/global", { cache: "no-store" }),
    ]);

    if (!pricesRes.ok || !globalRes.ok) {
      return NextResponse.json({ error: "Failed to fetch market data" }, { status: 502 });
    }

    const prices: PriceData = await pricesRes.json();
    const global: { data: CoinGeckoData } = await globalRes.json();

    // Calculate dominances
    const totalMcap = Object.values(global.data.market_cap_percentage || {}).reduce(
      (a, b) => a + b,
      0
    );
    const btcDominance = global.data.market_cap_percentage?.btc ?? 0;
    // USDT dominance from CoinGecko global isn't always present — calculate manually
    const tetherMcap = prices.tether?.usd_market_cap ?? 0;
    const totalMcapUsd = Object.values(prices).reduce(
      (sum, c) => sum + (c?.usd_market_cap ?? 0),
      0
    );
    // Better: use CoinGecko's per-coin dominance
    const usdtDominance = global.data.market_cap_percentage?.usdt ?? (tetherMcap / (totalMcapUsd || 1)) * 100;

    const marketData = {
      btcPrice: prices.bitcoin?.usd ?? 0,
      trxPrice: prices.tron?.usd ?? 0,
      solPrice: prices.solana?.usd ?? 0,
      ethPrice: prices.ethereum?.usd ?? 0,
      btcDominance,
      usdtDominance,
      trxMarketCap: prices.tron?.usd_market_cap ?? 0,
      solMarketCap: prices.solana?.usd_market_cap ?? 0,
      evalDate: new Date(),
    };

    // Run all claim evaluations
    const evaluations = THESIS_CLAIMS.map((claim) => {
      const result = claim.evaluate(marketData);
      return {
        id: claim.id,
        category: claim.category,
        claim: claim.claim,
        source: claim.source,
        status: result.status,
        reasoning: result.reasoning,
      };
    });

    // Aggregate verdict
    const counts = evaluations.reduce(
      (acc, e) => {
        acc[e.status] = (acc[e.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const total = evaluations.length;
    const broken = counts.broken || 0;
    const weakened = counts.weakened || 0;
    const fantasy = counts.fantasy || 0;
    const holding = counts.holding || 0;

    let overallStatus: "strong" | "holding" | "weakened" | "broken";
    if ((broken + fantasy) / total > 0.5) overallStatus = "broken";
    else if ((broken + weakened + fantasy) / total > 0.5) overallStatus = "weakened";
    else if (holding / total > 0.5) overallStatus = "strong";
    else overallStatus = "holding";

    return NextResponse.json({
      timestamp: marketData.evalDate.toISOString(),
      marketData: {
        btc: marketData.btcPrice,
        trx: marketData.trxPrice,
        sol: marketData.solPrice,
        btcDominance: marketData.btcDominance,
        usdtDominance: marketData.usdtDominance,
      },
      overallStatus,
      counts,
      evaluations,
    });
  } catch (e) {
    console.error("Thesis health check failed:", e);
    return NextResponse.json({ error: "Evaluation failed" }, { status: 500 });
  }
}
