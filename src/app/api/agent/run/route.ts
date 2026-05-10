// Cron-triggered agent run. Executes BOTH environments sequentially.
// Vercel Pro 5-min limit is enough for ~10 tool iterations × 2 envs.
import { NextRequest, NextResponse } from "next/server";
import { runAgent } from "@/lib/agent/loop";
import { db } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Strategic cron is daily at 12:00 UTC. Throttle 22h to allow scheduled
// runs but reject accidental hammering. Override with ?force=1.
const STRATEGIC_THROTTLE_MINUTES = 22 * 60;

async function lastStrategicRunMinsAgo(env: "paper" | "real"): Promise<number | null> {
  const sql = db();
  const rows = (await sql`
    SELECT MAX(ts) AS last_ts
      FROM agent_decisions
     WHERE environment = ${env} AND agent_kind = 'strategic'
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

  // Allow query param to run only one env (useful for debugging)
  const onlyEnv = req.nextUrl.searchParams.get("env") as "real" | "paper" | null;
  const force = req.nextUrl.searchParams.get("force") === "1";

  const results = [];
  for (const env of ["paper", "real"] as const) {
    if (onlyEnv && onlyEnv !== env) continue;

    if (!force) {
      const minsAgo = await lastStrategicRunMinsAgo(env);
      if (minsAgo !== null && minsAgo < STRATEGIC_THROTTLE_MINUTES) {
        results.push({
          environment: env,
          ok: true,
          throttled: true,
          minsAgo: Math.round(minsAgo * 10) / 10,
          message: `Last strategic run was ${Math.round(minsAgo)}min ago (throttle: ${STRATEGIC_THROTTLE_MINUTES}min). Use ?force=1 to override.`,
          iterations: 0,
          toolCalls: [],
          finalText: "",
        });
        continue;
      }
    }

    try {
      const r = await runAgent(env);
      results.push(r);
    } catch (e) {
      results.push({
        environment: env,
        ok: false,
        iterations: 0,
        toolCalls: [],
        finalText: "",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    results,
  });
}
