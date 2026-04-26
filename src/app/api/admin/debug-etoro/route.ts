// Raw eToro debug endpoint. Fires several requests with both env credentials
// and returns the literal status + body so we can see what eToro actually
// sends back. Gated by CRON_SECRET.
//
// Use:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<domain>/api/admin/debug-etoro?env=paper"
//
// Returns a list of probes with their raw response bodies (truncated).
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_URL = "https://public-api.etoro.com/api/v1";

interface Probe {
  name: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

function envHeaders(env: "paper" | "real"): Record<string, string> {
  const apiKey = process.env.ETORO_PUBLIC_KEY || "";
  const userKey = env === "paper"
    ? process.env.ETORO_PAPER_API_KEY || ""
    : process.env.ETORO_REAL_API_KEY || "";
  return {
    "x-api-key": apiKey,
    "x-user-key": userKey,
    "x-request-id": randomUUID(),
    "Accept": "application/json",
  };
}

async function runProbe(env: "paper" | "real", probe: Probe) {
  const url = new URL(BASE_URL + probe.path);
  if (probe.query) {
    for (const [k, v] of Object.entries(probe.query)) url.searchParams.set(k, v);
  }
  const init: RequestInit = {
    method: probe.method,
    headers: { ...envHeaders(env), ...(probe.body ? { "Content-Type": "application/json" } : {}) },
    cache: "no-store",
  };
  if (probe.body !== undefined) init.body = JSON.stringify(probe.body);

  let status = 0;
  let bodyText = "";
  let parsed: unknown = null;
  try {
    const res = await fetch(url.toString(), init);
    status = res.status;
    bodyText = await res.text();
    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // leave as text
      }
    }
  } catch (e) {
    bodyText = `FETCH FAILED: ${e instanceof Error ? e.message : String(e)}`;
  }

  return {
    name: probe.name,
    method: probe.method,
    fullUrl: url.toString(),
    status,
    bodyTextPreview: bodyText.slice(0, 14000),
    bodyTextEnd: bodyText.length > 14000 ? bodyText.slice(-3000) : null,
    parsedKeys: parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed as object)
      : null,
    parsedSampleArrayItem:
      Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null,
    parsedArrayLength: Array.isArray(parsed) ? parsed.length : null,
  };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const env = (req.nextUrl.searchParams.get("env") as "paper" | "real") || "paper";
  const testOpen = req.nextUrl.searchParams.get("testOpen") === "1";

  // Surface env-var presence (just lengths — never the actual keys)
  const envState = {
    ETORO_PUBLIC_KEY: process.env.ETORO_PUBLIC_KEY ? `present (${process.env.ETORO_PUBLIC_KEY.length} chars)` : "MISSING",
    ETORO_PAPER_API_KEY: process.env.ETORO_PAPER_API_KEY ? `present (${process.env.ETORO_PAPER_API_KEY.length} chars)` : "MISSING",
    ETORO_REAL_API_KEY: process.env.ETORO_REAL_API_KEY ? `present (${process.env.ETORO_REAL_API_KEY.length} chars)` : "MISSING",
  };

  const probes: Probe[] = [
    {
      name: "portfolio_pnl_full",
      method: "GET",
      path: `/trading/info/${env === "paper" ? "demo" : "real"}/pnl`,
    },
    {
      // Search BTC WITHOUT fields — returns full objects including symbolFull
      name: "search_BTC_no_fields",
      method: "GET",
      path: "/market-data/search",
      query: { searchText: "BTC", pageSize: "5" },
    },
    {
      // Search "Bitcoin" full word
      name: "search_Bitcoin_no_fields",
      method: "GET",
      path: "/market-data/search",
      query: { searchText: "Bitcoin", pageSize: "3" },
    },
    {
      // Look up specific known instrument IDs from existing positions to map IDs -> symbols
      // These are IDs we saw in the portfolio: 100003, 100017, 100061, 100063, 100340
      // Also probe 100000 hoping for BTC, 100002, 100007 (likely majors)
      name: "rates_known_ids",
      method: "GET",
      path: "/market-data/instruments/rates",
      query: { instrumentIds: "100000,100001,100002,100003,100007,100017,100061,100063,100340,100008" },
    },
    {
      // Try big pageSize to learn total count
      name: "instruments_list_max",
      method: "GET",
      path: "/market-data/instruments",
      query: { pageSize: "1000" },
    },
    {
      // Single ID rates
      name: "rates_single_100340",
      method: "GET",
      path: "/market-data/instruments/rates",
      query: { instrumentIds: "100340" },
    },
    {
      // Single-instrument metadata endpoint
      name: "instrument_100000_detail",
      method: "GET",
      path: "/market-data/instruments/100000",
    },
    {
      // Candles for instrument 100340 (which is in our portfolio — has real data)
      name: "candles_100340_daily_5",
      method: "GET",
      path: "/market-data/instruments/100340/history/candles/desc/OneDay/5",
    },
  ];

  // Optional: also do a $10 open-position test to capture eToro's raw response
  if (testOpen) {
    // Get GOLD's current rate so we can compute valid SL/TP
    const ratesProbe = await runProbe(env, {
      name: "_pre_test_rates",
      method: "GET",
      path: "/market-data/instruments/rates",
      query: { instrumentIds: "18" },
    });
    let entry = 0;
    try {
      const rj = JSON.parse(ratesProbe.bodyTextPreview) as { rates?: { ask: number; bid: number }[] };
      if (rj.rates?.[0]) entry = (rj.rates[0].ask + rj.rates[0].bid) / 2;
    } catch {}
    if (entry > 0) {
      // SHORT — SL above entry, TP below
      probes.push({
        name: "test_open_gold_short_10usd",
        method: "POST",
        path: `/trading/execution/${env === "paper" ? "demo" : "real"}/market-open-orders/by-amount`,
        body: {
          InstrumentID: 18,
          IsBuy: false,
          Leverage: 1,
          Amount: 10,
          StopLossRate: Number((entry * 1.03).toFixed(4)),
          TakeProfitRate: Number((entry * 0.95).toFixed(4)),
        },
      });
    } else {
      probes.push({
        name: "test_open_skipped_no_entry",
        method: "GET",
        path: "/market-data/instruments/rates",
        query: { instrumentIds: "18" },
      });
    }
  }

  const results = [];
  for (const p of probes) {
    results.push(await runProbe(env, p));
  }

  return NextResponse.json({
    env,
    envState,
    timestamp: new Date().toISOString(),
    results,
  });
}
