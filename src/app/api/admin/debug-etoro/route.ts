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
  method: "GET" | "POST" | "DELETE" | "PUT";
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
  const cancelOrderIds = req.nextUrl.searchParams.get("cancelOrders");
  const lookupOrderIds = req.nextUrl.searchParams.get("lookupOrders");
  const abandonTradeId = req.nextUrl.searchParams.get("abandonTrade");
  const listTradesLimit = req.nextUrl.searchParams.get("listTrades");
  const relinkTrade = req.nextUrl.searchParams.get("relinkTrade"); // tradeId,positionId
  const inspectDecisionId = req.nextUrl.searchParams.get("inspectDecision");
  const forceClosePosId = req.nextUrl.searchParams.get("forceClose"); // env=paper&forceClose=positionId,instrumentId
  const backfillUnitsTradeId = req.nextUrl.searchParams.get("backfillUnits"); // ?backfillUnits=tradeId — fetch units from eToro and write to DB

  // Backfill the `units` column from eToro live portfolio. Use when a
  // trade was recovered via ?relinkTrade and partial-close subsequently
  // fails with "unknown unit count".
  if (backfillUnitsTradeId) {
    const { db } = await import("@/lib/neon");
    const { etoro } = await import("@/lib/etoro/client");
    const sql = db();
    const trows = (await sql`
      SELECT id, etoro_position_id, environment, asset
        FROM trades
       WHERE id = ${backfillUnitsTradeId} AND status = 'open'
    `) as unknown as { id: string; etoro_position_id: string; environment: "paper" | "real"; asset: string }[];
    if (trows.length === 0) return NextResponse.json({ ok: false, error: "Trade not found or not open" });
    const t = trows[0];
    if (!t.etoro_position_id) return NextResponse.json({ ok: false, error: "Trade has no etoro_position_id" });
    try {
      const portfolio = await etoro.getPortfolio(t.environment);
      const livePos = portfolio.positions.find((p) => String(p.positionID) === t.etoro_position_id);
      if (!livePos) return NextResponse.json({ ok: false, error: "Position not found in eToro portfolio (closed?)" });
      const liveUnits = Number(livePos.units || 0);
      if (liveUnits <= 0) return NextResponse.json({ ok: false, error: "eToro returned 0 units for position" });
      await sql`UPDATE trades SET units = ${liveUnits} WHERE id = ${t.id}`;
      return NextResponse.json({ ok: true, tradeId: t.id, asset: t.asset, units: liveUnits });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }
  const cleanReasoning = req.nextUrl.searchParams.get("cleanReasoning"); // ?cleanReasoning=1 — backfill bad rows

  // One-shot: re-sanitize any agent_decisions / agent_memory rows whose
  // text contains the Haiku XML-tag-bleed artifact. Idempotent.
  if (cleanReasoning) {
    const { db } = await import("@/lib/neon");
    const { sanitizeReasoning } = await import("@/lib/agent/execute");
    const sql = db();
    // Postgres POSIX regex doesn't support \b, use LIKE
    const dirtyDecisions = (await sql`
      SELECT id, reasoning FROM agent_decisions
       WHERE reasoning LIKE '%<parameter%' OR reasoning LIKE '%</parameter%'
       ORDER BY ts DESC LIMIT 200
    `) as unknown as { id: string; reasoning: string }[];
    const dirtyMemory = (await sql`
      SELECT id, content FROM agent_memory
       WHERE content LIKE '%<parameter%' OR content LIKE '%</parameter%'
       ORDER BY ts DESC LIMIT 200
    `) as unknown as { id: string; content: string }[];

    let decUpdated = 0;
    for (const r of dirtyDecisions) {
      const cleaned = sanitizeReasoning(r.reasoning);
      if (cleaned !== r.reasoning) {
        await sql`UPDATE agent_decisions SET reasoning = ${cleaned} WHERE id = ${r.id}`;
        decUpdated++;
      }
    }
    let memUpdated = 0;
    for (const r of dirtyMemory) {
      const cleaned = sanitizeReasoning(r.content);
      if (cleaned !== r.content) {
        await sql`UPDATE agent_memory SET content = ${cleaned} WHERE id = ${r.id}`;
        memUpdated++;
      }
    }
    return NextResponse.json({
      ok: true,
      decisions: { found: dirtyDecisions.length, updated: decUpdated },
      memory:    { found: dirtyMemory.length,    updated: memUpdated },
    });
  }

  // Force-close a position via direct eToro API call. Use when an
  // agent trade has bad params and we want to exit before SL hits.
  // Now also captures best-effort exit_price + pnl_usd so the trade
  // contributes to learning/self-review.
  if (forceClosePosId) {
    const [posId, instId] = forceClosePosId.split(",");
    if (!posId || !instId) {
      return NextResponse.json({ error: "format: positionId,instrumentId" }, { status: 400 });
    }
    try {
      const { etoro } = await import("@/lib/etoro/client");
      const result = await etoro.closePosition(env, posId, Number(instId));
      const { db } = await import("@/lib/neon");
      const sql = db();
      // Pull trade context to compute PnL
      const tRows = (await sql`
        SELECT id, side, entry_price, size_usd, stop_loss
          FROM trades
         WHERE etoro_position_id = ${posId} AND status = 'open'
      `) as unknown as { id: string; side: "long" | "short"; entry_price: number; size_usd: number; stop_loss: number }[];
      let exitPrice: number | null = null;
      let pnlUsd = 0;
      let rMultiple: number | null = null;
      if (tRows.length > 0) {
        const t = tRows[0];
        try {
          const rates = await etoro.getRates([Number(instId)], env);
          if (rates.length > 0) {
            exitPrice = (rates[0].bid + rates[0].ask) / 2;
            const direction = t.side === "long" ? 1 : -1;
            const pctMove = ((exitPrice - Number(t.entry_price)) / Number(t.entry_price)) * direction;
            pnlUsd = Number(t.size_usd) * pctMove;
            const riskPerUnit = Math.abs(Number(t.entry_price) - Number(t.stop_loss));
            const moveAbs = Math.abs(exitPrice - Number(t.entry_price));
            if (riskPerUnit > 0) rMultiple = (moveAbs / riskPerUnit) * (pnlUsd >= 0 ? 1 : -1);
          }
        } catch {/* leave null */}
      }
      await sql`
        UPDATE trades
           SET status        = 'closed',
               closed_at     = now(),
               exit_price    = ${exitPrice},
               pnl_usd       = ${pnlUsd || null},
               r_multiple    = ${rMultiple},
               exit_reason   = 'manual_close',
               reconciled_at = now()
         WHERE etoro_position_id = ${posId} AND status = 'open'
      `;
      return NextResponse.json({ ok: true, closed: result, pnl_usd: pnlUsd, exit_price: exitPrice, r_multiple: rMultiple });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // Dump full raw_context + reasoning for a specific decision
  if (inspectDecisionId) {
    const { db } = await import("@/lib/neon");
    const sql = db();
    const rows = (await sql`
      SELECT id, ts, environment, agent_kind, decision_type, asset,
             reasoning, hvf_score, conviction, outcome_status,
             guardrail_violation, raw_context, trade_id
        FROM agent_decisions
       WHERE id = ${inspectDecisionId}
    `) as unknown as Record<string, unknown>[];
    return NextResponse.json({ ok: true, decision: rows[0] || null });
  }

  // Re-link a wrongly-cancelled trade to its actual eToro position.
  // Used to recover from the statusID=3 misinterpretation bug.
  if (relinkTrade) {
    const [tradeId, positionId] = relinkTrade.split(",");
    if (!tradeId || !positionId) {
      return NextResponse.json({ error: "format: tradeId,positionId" }, { status: 400 });
    }
    const { db } = await import("@/lib/neon");
    const sql = db();
    const rows = (await sql`
      UPDATE trades
         SET status            = 'open',
             etoro_position_id = ${positionId},
             closed_at         = NULL,
             exit_reason       = NULL,
             reconciled_at     = now()
       WHERE id = ${tradeId}
       RETURNING id, environment, asset, etoro_position_id
    `) as unknown as { id: string; environment: "paper" | "real"; asset: string; etoro_position_id: string }[];
    if (rows.length > 0) {
      await sql`
        UPDATE guardrail_state gs
           SET open_position_count = (
             SELECT COUNT(*)::int FROM trades
              WHERE environment = gs.environment
                AND status = 'open'
                AND etoro_position_id IS NOT NULL AND etoro_position_id <> ''
           )
         WHERE environment = ${rows[0].environment}
      `;
      // Also fetch + persist units from eToro so partial-close works
      // out of the box for the restored trade.
      let unitsBackfilled: number | null = null;
      try {
        const { etoro } = await import("@/lib/etoro/client");
        const portfolio = await etoro.getPortfolio(rows[0].environment);
        const livePos = portfolio.positions.find((p) => String(p.positionID) === positionId);
        if (livePos && livePos.units && Number(livePos.units) > 0) {
          unitsBackfilled = Number(livePos.units);
          await sql`UPDATE trades SET units = ${unitsBackfilled} WHERE id = ${tradeId}`;
        }
      } catch { /* non-fatal */ }
      return NextResponse.json({ ok: true, relinked: rows[0], unitsBackfilled });
    }
    return NextResponse.json({ ok: false, message: "Trade not found" });
  }

  // Dump latest N trades from DB regardless of status
  if (listTradesLimit) {
    const n = Math.max(1, Math.min(100, parseInt(listTradesLimit, 10) || 20));
    const { db } = await import("@/lib/neon");
    const sql = db();
    const rows = await sql`
      SELECT id, environment, asset, side, status, entry_price, size_usd,
             stop_loss, take_profit, etoro_order_id, etoro_position_id,
             opened_at, closed_at, exit_reason, reconciled_at
        FROM trades
       ORDER BY opened_at DESC
       LIMIT ${n}
    `;
    return NextResponse.json({ ok: true, trades: rows });
  }

  // One-off DB action: mark a stale agent trade as abandoned and
  // decrement open_position_count. Use when reconciler can't yet
  // resolve a row (e.g. legacy entries with no etoro_order_id).
  if (abandonTradeId) {
    const { db } = await import("@/lib/neon");
    const sql = db();
    const rows = (await sql`
      UPDATE trades
         SET status        = 'abandoned',
             closed_at     = now(),
             exit_reason   = 'expired',
             reconciled_at = now()
       WHERE id = ${abandonTradeId} AND status = 'open'
       RETURNING id, environment
    `) as unknown as { id: string; environment: "paper" | "real" }[];
    if (rows.length > 0) {
      // Defensive: re-derive open count from reality
      await sql`
        UPDATE guardrail_state gs
           SET open_position_count = (
             SELECT COUNT(*)::int FROM trades
              WHERE environment = gs.environment
                AND status = 'open'
                AND etoro_position_id IS NOT NULL
                AND etoro_position_id <> ''
           )
         WHERE environment = ${rows[0].environment}
      `;
      return NextResponse.json({ ok: true, abandoned: rows[0] });
    }
    return NextResponse.json({ ok: false, message: "Trade not found or not open" });
  }

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

  // Optional: cancel pending orders (comma-separated IDs)
  if (cancelOrderIds) {
    for (const oid of cancelOrderIds.split(",").map((s) => s.trim()).filter(Boolean)) {
      probes.push({
        name: `cancel_order_${oid}`,
        method: "DELETE",
        path: `/trading/execution/${env === "paper" ? "demo" : "real"}/market-open-orders/${oid}`,
      });
    }
  }

  // Optional: look up order info (comma-separated IDs)
  if (lookupOrderIds) {
    for (const oid of lookupOrderIds.split(",").map((s) => s.trim()).filter(Boolean)) {
      probes.push({
        name: `lookup_order_${oid}`,
        method: "GET",
        path: `/trading/info/${env === "paper" ? "demo" : "real"}/orders/${oid}`,
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
