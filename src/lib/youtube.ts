// YouTube Data API v3 helpers
// Resolves channel handles → channel IDs → recent videos

interface YTSearchItem {
  id: { kind: string; videoId?: string; channelId?: string };
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    thumbnails?: { high?: { url: string }; default?: { url: string } };
  };
}

interface YTChannelItem {
  id: string;
  snippet: { title: string; customUrl?: string };
  contentDetails: { relatedPlaylists: { uploads: string } };
}

interface YTPlaylistItem {
  contentDetails: { videoId: string; videoPublishedAt: string };
  snippet: { title: string; thumbnails?: { high?: { url: string }; default?: { url: string } } };
}

interface YTVideoItem {
  id: string;
  contentDetails: { duration: string };
}

const API_BASE = "https://www.googleapis.com/youtube/v3";

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("Missing YOUTUBE_API_KEY env var");
  return key;
}

/** Resolve @handle → channel ID. Caches not implemented — call sparingly. */
export async function resolveHandleToChannelId(handle: string): Promise<{ channelId: string; uploadsPlaylistId: string }> {
  const cleanHandle = handle.startsWith("@") ? handle : `@${handle}`;
  const url = `${API_BASE}/channels?part=snippet,contentDetails&forHandle=${encodeURIComponent(cleanHandle)}&key=${apiKey()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`YouTube channels.list failed: ${res.status} ${await res.text()}`);
  const data: { items?: YTChannelItem[] } = await res.json();
  const item = data.items?.[0];
  if (!item) throw new Error(`Channel not found for handle ${handle}`);
  return {
    channelId: item.id,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
  };
}

/** Get latest videos from a channel's uploads playlist. */
export async function getLatestVideos(uploadsPlaylistId: string, maxResults = 10): Promise<{
  videoId: string;
  title: string;
  publishedAt: string;
  thumbnailUrl: string | null;
}[]> {
  const url = `${API_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${apiKey()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`YouTube playlistItems.list failed: ${res.status} ${await res.text()}`);
  const data: { items?: YTPlaylistItem[] } = await res.json();
  return (data.items || []).map((item) => ({
    videoId: item.contentDetails.videoId,
    title: item.snippet.title,
    publishedAt: item.contentDetails.videoPublishedAt,
    thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || null,
  }));
}

/** Get duration (in seconds) for one or more video IDs. */
export async function getVideoDurations(videoIds: string[]): Promise<Map<string, number>> {
  if (videoIds.length === 0) return new Map();
  const url = `${API_BASE}/videos?part=contentDetails&id=${videoIds.join(",")}&key=${apiKey()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`YouTube videos.list failed: ${res.status}`);
  const data: { items?: YTVideoItem[] } = await res.json();
  const map = new Map<string, number>();
  for (const item of data.items || []) {
    map.set(item.id, parseISO8601Duration(item.contentDetails.duration));
  }
  return map;
}

/** Parse ISO 8601 duration like PT1H23M45S to seconds. */
export function parseISO8601Duration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + min * 60 + s;
}
