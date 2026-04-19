import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface Analyst {
  id: string;
  name: string;
  channel_handle: string;
  channel_id: string | null;
  description: string | null;
  color: string;
}

export interface VideoRow {
  id: string;
  analyst_id: string;
  title: string;
  published_at: string;
  url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  summary: string | null;
  sentiment: "bullish" | "bearish" | "neutral" | "mixed" | null;
  key_takeaways: string[] | null;
  fetched_at: string;
  analyzed_at: string | null;
  analysis_error: string | null;
}

export interface ClaimRow {
  id: string;
  video_id: string;
  analyst_id: string;
  asset: string;
  claim_type: string;
  direction: "bullish" | "bearish" | "neutral" | null;
  price_level: number | null;
  timeframe: string | null;
  description: string;
  confidence: "high" | "medium" | "low" | null;
  created_at: string;
}

let _publicClient: SupabaseClient | null = null;
let _serviceClient: SupabaseClient | null = null;

/** Public read-only client (uses anon key). Safe for browser if exposed via NEXT_PUBLIC_*. */
export function publicClient(): SupabaseClient {
  if (_publicClient) return _publicClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  _publicClient = createClient(url, key, { auth: { persistSession: false } });
  return _publicClient;
}

/** Server-only client with full write access. NEVER expose to browser. */
export function serviceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  _serviceClient = createClient(url, key, { auth: { persistSession: false } });
  return _serviceClient;
}
