// Cron-triggered tactical agent run.
// Default: paper-only (safer first deployment). Pass ?env=real to run Real.
import { NextRequest, NextResponse } from "next/server";
import { runTacticalAgent } from "@/lib/agent/tactical-loop";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // First-deployment default: paper-only. Manually opt-in to real with ?env=real.
  // Once we trust tactical's behavior, we can add `?env=both` to vercel cron.
  const envParam = req.nextUrl.searchParams.get("env") as "paper" | "real" | "both" | null;
  const envs: ("paper" | "real")[] =
    envParam === "real" ? ["real"]
    : envParam === "both" ? ["paper", "real"]
    : ["paper"];

  const results = [];
  for (const env of envs) {
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
