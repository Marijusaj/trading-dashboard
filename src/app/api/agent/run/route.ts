// Cron-triggered agent run. Executes BOTH environments sequentially.
// Vercel Pro 5-min limit is enough for ~10 tool iterations × 2 envs.
import { NextRequest, NextResponse } from "next/server";
import { runAgent } from "@/lib/agent/loop";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Allow query param to run only one env (useful for debugging)
  const onlyEnv = req.nextUrl.searchParams.get("env") as "real" | "paper" | null;

  const results = [];
  for (const env of ["paper", "real"] as const) {
    if (onlyEnv && onlyEnv !== env) continue;
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
