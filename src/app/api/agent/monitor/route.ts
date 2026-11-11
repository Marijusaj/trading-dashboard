// Cron-triggered stop monitor (every minute). No model call — closes
// managed-stop trades whose price crossed their stop or target.
import { NextRequest, NextResponse } from "next/server";
import { enforceManagedStops } from "@/lib/agent/stop-monitor";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const report = await enforceManagedStops("paper");
    if (report.closed.length > 0 || report.errors.length > 0) {
      console.log("[stop-monitor]", JSON.stringify(report));
    }
    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), report });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[stop-monitor] failed:", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
