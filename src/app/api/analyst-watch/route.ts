import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { YoutubeTranscript } from "youtube-transcript";
import { serviceClient, type Analyst } from "@/lib/supabase";
import { resolveHandleToChannelId, getLatestVideos, getVideoDurations } from "@/lib/youtube";
import { VIDEO_ANALYSIS_PROMPT, type AnalysisResult } from "@/lib/analyst-prompt";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — Vercel Pro can do this

const MAX_VIDEOS_PER_RUN = 3; // Avoid blowing API budget on first run with backlog
const MIN_DURATION_SECONDS = 300; // Skip videos shorter than 5 min (likely shorts/promos)

interface RunSummary {
  analyst_id: string;
  fetched: number;
  new: number;
  analyzed: number;
  errors: string[];
}

async function fetchTranscript(videoId: string): Promise<string | null> {
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
    if (!items || items.length === 0) return null;
    return items.map((i) => i.text).join(" ");
  } catch {
    // Try without language preference
    try {
      const items = await YoutubeTranscript.fetchTranscript(videoId);
      if (!items || items.length === 0) return null;
      return items.map((i) => i.text).join(" ");
    } catch {
      return null;
    }
  }
}

async function analyzeWithClaude(
  anthropic: Anthropic,
  analystName: string,
  videoTitle: string,
  transcript: string,
): Promise<AnalysisResult | null> {
  // Truncate very long transcripts (Claude can handle but cost concern)
  const cleaned = transcript.replace(/\s+/g, " ").trim();
  const maxChars = 80_000; // ~20k tokens
  const truncated = cleaned.length > maxChars ? cleaned.slice(0, maxChars) + "\n[...truncated]" : cleaned;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4000,
      system: VIDEO_ANALYSIS_PROMPT,
      messages: [
        {
          role: "user",
          content: `Analyst: ${analystName}\nVideo title: ${videoTitle}\n\nTranscript:\n${truncated}\n\nReturn the JSON now.`,
        },
      ],
    });
    const text = msg.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");
    // Strip markdown code fences if present
    const cleanedText = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleanedText) as AnalysisResult;
    return parsed;
  } catch (e) {
    console.error("Claude analysis failed:", e);
    return null;
  }
}

async function processAnalyst(
  anthropic: Anthropic,
  supabase: ReturnType<typeof serviceClient>,
  analyst: Analyst,
): Promise<RunSummary> {
  const summary: RunSummary = {
    analyst_id: analyst.id,
    fetched: 0,
    new: 0,
    analyzed: 0,
    errors: [],
  };

  try {
    // 1. Resolve channel + uploads playlist (cache channel_id back to DB)
    let channelId = analyst.channel_id;
    let uploadsPlaylistId: string;
    if (!channelId) {
      const resolved = await resolveHandleToChannelId(analyst.channel_handle);
      channelId = resolved.channelId;
      uploadsPlaylistId = resolved.uploadsPlaylistId;
      await supabase.from("analysts").update({ channel_id: channelId }).eq("id", analyst.id);
    } else {
      // Channel ID = "UCxxx", uploads playlist = "UU" + suffix
      uploadsPlaylistId = "UU" + channelId.slice(2);
    }

    // 2. Get latest videos
    const videos = await getLatestVideos(uploadsPlaylistId, 10);
    summary.fetched = videos.length;

    // 3. Filter to videos NOT already in DB
    const ids = videos.map((v) => v.videoId);
    const { data: existing } = await supabase.from("videos").select("id").in("id", ids);
    const existingIds = new Set((existing || []).map((r) => r.id));
    const newVideos = videos.filter((v) => !existingIds.has(v.videoId));
    summary.new = newVideos.length;

    if (newVideos.length === 0) return summary;

    // 4. Get durations for filtering
    const durations = await getVideoDurations(newVideos.map((v) => v.videoId));

    // 5. Process up to MAX_VIDEOS_PER_RUN, longest-first to prioritize substantive content
    const sorted = newVideos
      .map((v) => ({ ...v, duration: durations.get(v.videoId) || 0 }))
      .filter((v) => v.duration >= MIN_DURATION_SECONDS)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, MAX_VIDEOS_PER_RUN);

    for (const v of sorted) {
      try {
        // Insert video stub first so we have a record even if analysis fails
        const baseRow = {
          id: v.videoId,
          analyst_id: analyst.id,
          title: v.title,
          published_at: v.publishedAt,
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          thumbnail_url: v.thumbnailUrl,
          duration_seconds: v.duration,
        };
        await supabase.from("videos").upsert(baseRow);

        // Fetch transcript
        const transcript = await fetchTranscript(v.videoId);
        if (!transcript) {
          await supabase.from("videos").update({
            transcript: null,
            analysis_error: "No transcript available",
          }).eq("id", v.videoId);
          summary.errors.push(`${v.videoId}: no transcript`);
          continue;
        }

        // Analyze with Claude
        const analysis = await analyzeWithClaude(anthropic, analyst.name, v.title, transcript);
        if (!analysis) {
          await supabase.from("videos").update({
            transcript,
            analysis_error: "Claude analysis failed",
          }).eq("id", v.videoId);
          summary.errors.push(`${v.videoId}: claude failed`);
          continue;
        }

        // Save analysis
        await supabase.from("videos").update({
          transcript,
          summary: analysis.summary,
          sentiment: analysis.sentiment,
          key_takeaways: analysis.key_takeaways,
          analyzed_at: new Date().toISOString(),
          analysis_error: null,
        }).eq("id", v.videoId);

        // Save claims
        if (analysis.claims.length > 0) {
          const claimRows = analysis.claims.map((c) => ({
            video_id: v.videoId,
            analyst_id: analyst.id,
            asset: c.asset,
            claim_type: c.claim_type,
            direction: c.direction,
            price_level: c.price_level,
            timeframe: c.timeframe,
            description: c.description,
            confidence: c.confidence,
          }));
          await supabase.from("claims").insert(claimRows);
        }

        summary.analyzed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.errors.push(`${v.videoId}: ${msg}`);
      }
    }
  } catch (e) {
    summary.errors.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  }

  return summary;
}

export async function GET(req: NextRequest) {
  // Verify cron auth (Vercel injects Authorization: Bearer <CRON_SECRET>)
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Skip silently if Phase 2 isn't configured
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "Supabase not configured — analyst-watch is disabled.",
    });
  }
  if (!process.env.YOUTUBE_API_KEY) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "YOUTUBE_API_KEY not set — cannot fetch videos.",
    });
  }

  try {
    const supabase = serviceClient();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Load all analysts
    const { data: analysts, error } = await supabase.from("analysts").select("*");
    if (error) throw error;
    if (!analysts || analysts.length === 0) {
      return NextResponse.json({ error: "No analysts configured" }, { status: 500 });
    }

    // Process each analyst sequentially to avoid hitting YouTube rate limits in parallel
    const results: RunSummary[] = [];
    for (const analyst of analysts as Analyst[]) {
      const result = await processAnalyst(anthropic, supabase, analyst);
      results.push(result);
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      results,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
