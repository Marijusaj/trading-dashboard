// Read-only portfolio fetch for both eToro accounts.
// Used by the dashboard to display positions + equity.
import { NextResponse } from "next/server";
import { etoro } from "@/lib/etoro/client";
import type { EtoroEnv, EtoroPortfolio, EtoroPosition, EtoroRate } from "@/lib/etoro/types";

export const dynamic = "force-dynamic";
// Cache short — reduces eToro API hits if dashboard polls aggressively
export const revalidate = 60;

interface EnrichedPosition extends EtoroPosition {
  symbol: string | null;
  currentPrice: number | null;
  unrealizedPnL: number | null;
  unrealizedPnLPct: number | null;
}

interface EnvSnapshot {
  env: EtoroEnv;
  ok: boolean;
  error: string | null;
  credit: number | null;
  positions: EnrichedPosition[];
  totalUnrealizedPnL: number | null;
  totalEquity: number | null;
}

async function snapshotEnv(env: EtoroEnv): Promise<EnvSnapshot> {
  try {
    const portfolio: EtoroPortfolio = await etoro.getPortfolio(env);
    const positions = portfolio.positions || [];

    // Enrich positions with current prices for live PnL
    const instrumentIds = [...new Set(positions.map((p) => p.instrumentID))];
    let rates: EtoroRate[] = [];
    if (instrumentIds.length > 0) {
      try {
        rates = await etoro.getRates(instrumentIds);
      } catch {
        // Rates failure is non-fatal — show position without live PnL
      }
    }
    const rateMap = new Map(rates.map((r) => [r.instrumentID, r]));

    let totalUnrealizedPnL = 0;
    const enriched: EnrichedPosition[] = positions.map((p) => {
      const rate = rateMap.get(p.instrumentID);
      const mid = rate ? (rate.bid + rate.ask) / 2 : null;
      let unrealizedPnL: number | null = null;
      let unrealizedPnLPct: number | null = null;
      if (mid !== null && p.openRate > 0) {
        const direction = p.isBuy ? 1 : -1;
        const pctMove = ((mid - p.openRate) / p.openRate) * direction;
        unrealizedPnLPct = pctMove * 100 * (p.leverage || 1);
        if (p.amountInDollars) {
          unrealizedPnL = p.amountInDollars * pctMove * (p.leverage || 1);
          totalUnrealizedPnL += unrealizedPnL;
        }
      }
      return {
        ...p,
        symbol: null, // resolved later if we cache instrument metadata
        currentPrice: mid,
        unrealizedPnL,
        unrealizedPnLPct,
      };
    });

    const credit = portfolio.credit ?? null;
    const totalEquity = credit !== null ? credit + totalUnrealizedPnL : null;

    return {
      env,
      ok: true,
      error: null,
      credit,
      positions: enriched,
      totalUnrealizedPnL: enriched.length > 0 ? totalUnrealizedPnL : null,
      totalEquity,
    };
  } catch (e) {
    return {
      env,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      credit: null,
      positions: [],
      totalUnrealizedPnL: null,
      totalEquity: null,
    };
  }
}

export async function GET() {
  // Fail loudly if env vars missing — better than silent empty state
  if (!process.env.ETORO_PUBLIC_KEY) {
    return NextResponse.json(
      { error: "ETORO_PUBLIC_KEY not configured" },
      { status: 500 },
    );
  }

  const [paper, real] = await Promise.all([snapshotEnv("paper"), snapshotEnv("real")]);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    accounts: { paper, real },
  });
}
