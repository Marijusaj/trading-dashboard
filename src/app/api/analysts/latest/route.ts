import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 300; // 5 min cache on edge

/** True if Supabase env vars look configured. */
function supabaseConfigured(): boolean {
  return !!(
    (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET() {
  // Graceful empty when Phase 2 (analyst-watch) isn't wired up yet.
  // Returning 500 was breaking the dashboard render.
  if (!supabaseConfigured()) {
    return NextResponse.json({
      analysts: [],
      timestamp: new Date().toISOString(),
      notice: "Supabase not configured — analyst-watch is disabled. Add NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in Vercel env vars to enable.",
    });
  }
  try {
    const supabase = serviceClient();

    // Fetch analysts
    const { data: analysts, error: aErr } = await supabase
      .from("analysts")
      .select("id, name, channel_handle, description, color");
    if (aErr) throw aErr;

    // For each analyst, fetch latest 5 videos
    const result = await Promise.all(
      (analysts || []).map(async (analyst) => {
        const { data: videos } = await supabase
          .from("videos")
          .select("id, title, published_at, url, thumbnail_url, summary, sentiment, key_takeaways, analyzed_at, analysis_error")
          .eq("analyst_id", analyst.id)
          .order("published_at", { ascending: false })
          .limit(5);

        // Get the latest analyzed video's claims
        const latestAnalyzed = (videos || []).find((v) => v.analyzed_at);
        let claims: Array<{
          asset: string;
          claim_type: string;
          direction: string | null;
          price_level: number | null;
          timeframe: string | null;
          description: string;
          confidence: string | null;
        }> = [];
        if (latestAnalyzed) {
          const { data: claimRows } = await supabase
            .from("claims")
            .select("asset, claim_type, direction, price_level, timeframe, description, confidence")
            .eq("video_id", latestAnalyzed.id);
          claims = claimRows || [];
        }

        return {
          ...analyst,
          videos: videos || [],
          latestClaims: claims,
        };
      }),
    );

    return NextResponse.json({ analysts: result, timestamp: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
