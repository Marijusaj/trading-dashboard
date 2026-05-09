// Cron-triggered Binance agent run.
// Runs the Binance Spot agent loop. Throttled to avoid double-firing.
import { NextRequest, NextResponse } from "next/server";
import { runBinanceAgent } from "@/lib/agent/binance-loop";
import { db } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Cron is every 6h. Throttle 5h to allow scheduled runs but reject
// accidental hammering. Override with ?force=1.
const BINANCE_THROTTLE_MINUTES = 5 * 60;

async function lastBinanceRunMinsAgo(): Promise<number | null> {
  const sql = db();
  const rows = (await sql`
    SELECT MAX(ts) AS last_ts
      FROM agent_decisions
     WHERE environment = 'binance'
  `) as unknown as { last_ts: string | null }[];
  const ts = rows[0]?.last_ts;
  if (!ts) return null;
  return (Date.now() - new Date(ts).getTime()) / 60_000;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("force") === "1";

  if (!force) {
    const minsAgo = await lastBinanceRunMinsAgo();
    if (minsAgo !== null && minsAgo < BINANCE_THROTTLE_MINUTES) {
      return NextResponse.json({
        ok: true,
        throttled: true,
        minsAgo: Math.round(minsAgo * 10) / 10,
        message: `Last Binance run was ${Math.round(minsAgo)}min ago (throttle: ${BINANCE_THROTTLE_MINUTES}min). Use ?force=1 to override.`,
      });
    }
  }

  try {
    const r = await runBinanceAgent();
    return NextResponse.json({ timestamp: new Date().toISOString(), ...r });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      timestamp: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
