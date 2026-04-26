"use client";

import { useEffect, useState } from "react";

interface Video {
  id: string;
  title: string;
  published_at: string;
  url: string;
  thumbnail_url: string | null;
  summary: string | null;
  sentiment: "bullish" | "bearish" | "neutral" | "mixed" | null;
  key_takeaways: string[] | null;
  analyzed_at: string | null;
  analysis_error: string | null;
}

interface Claim {
  asset: string;
  claim_type: string;
  direction: string | null;
  price_level: number | null;
  timeframe: string | null;
  description: string;
  confidence: string | null;
}

interface AnalystData {
  id: string;
  name: string;
  channel_handle: string;
  description: string | null;
  color: string;
  videos: Video[];
  latestClaims: Claim[];
}

const SENTIMENT_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  bullish: { label: "BULLISH", color: "text-green-400", bg: "bg-green-950/40" },
  bearish: { label: "BEARISH", color: "text-red-400", bg: "bg-red-950/40" },
  neutral: { label: "NEUTRAL", color: "text-gray-400", bg: "bg-gray-950/40" },
  mixed: { label: "MIXED", color: "text-amber-400", bg: "bg-amber-950/40" },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function AnalystCard({ analyst }: { analyst: AnalystData }) {
  const latest = analyst.videos[0];
  const sentimentStyle = latest?.sentiment ? SENTIMENT_STYLES[latest.sentiment] : null;

  return (
    <div className="bg-[#0f0f0f] border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div
        className="px-3 py-2 border-b border-gray-800 flex items-center gap-2"
        style={{ borderLeft: `3px solid ${analyst.color}` }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-white font-semibold text-sm truncate">{analyst.name}</div>
          <div className="text-gray-500 text-[10px]">{analyst.channel_handle}</div>
        </div>
        {sentimentStyle && (
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${sentimentStyle.color} ${sentimentStyle.bg}`}>
            {sentimentStyle.label}
          </span>
        )}
      </div>

      {/* Latest video */}
      {!latest ? (
        <div className="p-3 text-gray-500 text-xs italic">No videos fetched yet. Cron will populate.</div>
      ) : (
        <div className="p-3 space-y-2">
          <a
            href={latest.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block hover:bg-gray-900/30 -mx-1 px-1 py-1 rounded transition-colors"
          >
            <div className="flex items-start gap-2">
              {latest.thumbnail_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={latest.thumbnail_url} alt="" className="w-20 h-12 object-cover rounded flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-white text-xs font-medium leading-tight line-clamp-2">{latest.title}</div>
                <div className="text-gray-600 text-[10px] mt-0.5">{timeAgo(latest.published_at)}</div>
              </div>
            </div>
          </a>

          {latest.summary && <div className="text-gray-400 text-[11px] leading-snug">{latest.summary}</div>}

          {latest.key_takeaways && latest.key_takeaways.length > 0 && (
            <ul className="text-[10px] text-gray-500 space-y-0.5">
              {latest.key_takeaways.slice(0, 4).map((t, i) => (
                <li key={i} className="flex gap-1">
                  <span className="text-gray-700">•</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}

          {analyst.latestClaims.length > 0 && (
            <div className="mt-2">
              <div className="text-gray-500 text-[10px] mb-1 uppercase tracking-wider">Key Claims</div>
              <div className="space-y-1">
                {analyst.latestClaims.slice(0, 5).map((c, i) => {
                  const directionColor =
                    c.direction === "bullish"
                      ? "text-green-400"
                      : c.direction === "bearish"
                      ? "text-red-400"
                      : "text-gray-400";
                  return (
                    <div key={i} className="text-[10px] flex items-center gap-1.5 font-mono bg-gray-900/40 rounded px-1.5 py-1">
                      <span className="text-amber-400 font-bold w-8">{c.asset}</span>
                      {c.price_level !== null && (
                        <span className={`${directionColor} font-semibold w-14`}>
                          ${c.price_level < 1 ? c.price_level.toFixed(4) : c.price_level.toLocaleString()}
                        </span>
                      )}
                      <span className="text-gray-500">{c.claim_type}</span>
                      <span className="text-gray-600 truncate flex-1 font-sans">{c.description}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {latest.analysis_error && (
            <div className="text-red-500 text-[10px] italic">Analysis failed: {latest.analysis_error}</div>
          )}
          {!latest.analyzed_at && !latest.analysis_error && (
            <div className="text-amber-500 text-[10px] italic">Not yet analyzed — cron pending</div>
          )}
        </div>
      )}

      {/* Video history */}
      {analyst.videos.length > 1 && (
        <div className="border-t border-gray-800 px-3 py-2">
          <div className="text-gray-600 text-[10px] mb-1 uppercase tracking-wider">Recent Videos</div>
          <div className="space-y-0.5">
            {analyst.videos.slice(1, 5).map((v) => {
              const s = v.sentiment ? SENTIMENT_STYLES[v.sentiment] : null;
              return (
                <a
                  key={v.id}
                  href={v.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-2 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <span className="text-gray-700 w-12">{timeAgo(v.published_at)}</span>
                  <span className="truncate flex-1">{v.title}</span>
                  {s && <span className={s.color}>●</span>}
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AnalystWatch() {
  const [analysts, setAnalysts] = useState<AnalystData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/analysts/latest", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (json.error) setError(json.error);
        else {
          setAnalysts(json.analysts || []);
          setNotice(json.notice || null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 900_000); // 15 min
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
        <div className="text-gray-500 text-sm animate-pulse">Loading analyst watch...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#111] border border-red-900/50 rounded-lg p-4">
        <div className="text-red-400 text-sm">
          Failed to load: {error}
          <div className="text-gray-500 text-xs mt-1">
            Check Supabase env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white font-semibold">🎥 Analyst Watch</div>
            <div className="text-gray-500 text-xs">Latest videos auto-summarized by Claude daily</div>
          </div>
          <div className="text-gray-600 text-[10px]">{analysts.length} analysts</div>
        </div>
      </div>
      {notice && analysts.length === 0 && (
        <div className="p-3 text-xs text-amber-400 bg-amber-950/20 border-b border-amber-900/30">
          {notice}
        </div>
      )}
      {!notice && analysts.length === 0 && (
        <div className="p-6 text-center text-gray-500 text-sm">
          No analyst data yet. Cron will populate.
        </div>
      )}
      {analysts.length > 0 && (
        <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          {analysts.map((a) => (
            <AnalystCard key={a.id} analyst={a} />
          ))}
        </div>
      )}
    </div>
  );
}
