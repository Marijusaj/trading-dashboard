// Cron-triggered tactical agent run.
// Default: paper-only (safer first deployment). Pass ?env=real to run Real.
import { NextRequest, NextResponse } from "next/server";
import { runTacticalAgent } from "@/lib/agent/tactical-loop";
import { db } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Throttle: skip a tactical run if one happened for this env within
// the last N minutes. Cron is every 2h so 110min is the right cushion
// (allows scheduled runs but blocks accidental hammering).
// Override with ?force=1 (e.g. for manual debugging).
const TACTICAL_THROTTLE_MINUTES = 110;

async function lastTacticalRunMinsAgo(env: "paper" | "real"): Promise<number | null> {
  const sql = db();
  const rows = (await sql`
    SELECT MAX(ts) AS last_ts
      FROM agent_decisions
     WHERE environment = ${env} AND agent_kind = 'tactical'
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

  // First-deployment default: paper-only. Manually opt-in to real with ?env=real.
  // Once we trust tactical's behavior, we can add `?env=both` to vercel cron.
  const envParam = req.nextUrl.searchParams.get("env") as "paper" | "real" | "both" | null;
  const force = req.nextUrl.searchParams.get("force") === "1";
  const envs: ("paper" | "real")[] =
    envParam === "real" ? ["real"]
    : envParam === "both" ? ["paper", "real"]
    : ["paper"];

  const results = [];
  for (const env of envs) {
    if (!force) {
      const minsAgo = await lastTacticalRunMinsAgo(env);
      if (minsAgo !== null && minsAgo < TACTICAL_THROTTLE_MINUTES) {
        results.push({
          environment: env,
          agentKind: "tactical" as const,
          ok: true,
          throttled: true,
          minsAgo: Math.round(minsAgo * 10) / 10,
          message: `Last tactical run was ${Math.round(minsAgo)}min ago (throttle: ${TACTICAL_THROTTLE_MINUTES}min). Use ?force=1 to override.`,
          iterations: 0,
          toolCalls: [],
          finalText: "",
        });
        continue;
      }
    }
    try {
      const r = await runTacticalAgent(env);
      results.push(r);
    } catch (e) {
      results.push({
        environment: env,
        agentKind: "tactical" as const,
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
