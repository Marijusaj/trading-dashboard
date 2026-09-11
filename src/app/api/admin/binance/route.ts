// Binance smoke test + manual trigger endpoint.
//
// Gated by CRON_SECRET (Bearer token). Use this to:
//   1. Verify the API keys work          ?action=ping
//   2. See your balances                  ?action=balances
//   3. Run HVF on any symbol             ?action=scan&symbol=TRX&tf=1d
//   4. Place a manual market buy          ?action=buy&symbol=TRX&size=50
//   5. Place a manual market sell         ?action=sell&symbol=TRX&qty=100
//   6. List open orders                   ?action=open
//   7. Verify the USDC pair map          ?action=pairs
//      (also runs daily at 07:00 UTC via vercel.json — Vercel sends the
//       CRON_SECRET bearer itself; problems land in runtime logs as
//       [binance-pairs] errors, since the JSON body has no reader on cron)
//
// This is the manual interface while autonomous Binance trading is
// still being wired up. Once the Binance cron route lands, the agent
// will use these same primitives autonomously.

import { NextRequest, NextResponse } from "next/server";
import { binance } from "@/lib/binance/client";
import { binanceSymbol, timeframeToBinanceInterval, BINANCE_USDC_SYMBOL } from "@/lib/binance/symbols";
import { UNIVERSE } from "@/lib/agent/universe";
import { analyzeHVF } from "@/lib/agent/hvf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const action = req.nextUrl.searchParams.get("action") || "ping";
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  const tf = req.nextUrl.searchParams.get("tf") || "1d";
  const sizeUsd = req.nextUrl.searchParams.get("size");
  const qty = req.nextUrl.searchParams.get("qty");

  try {
    switch (action) {
      case "ping": {
        const out = await binance.ping();
        // Also confirm signed call works by hitting account
        const acct = await binance.account();
        return NextResponse.json({
          ok: true,
          publicReachable: true,
          serverTime: new Date(out.serverTime).toISOString(),
          driftMs: out.nowDriftMs,
          accountType: acct.accountType,
          canTrade: acct.canTrade,
          balanceCount: acct.balances.length,
        });
      }

      case "balances": {
        const acct = await binance.account();
        return NextResponse.json({
          ok: true,
          accountType: acct.accountType,
          canTrade: acct.canTrade,
          balances: acct.balances.sort((a, b) => b.free - a.free),
        });
      }

      case "scan": {
        if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
        const pair = binanceSymbol(symbol);
        if (!pair) return NextResponse.json({ error: `No USDC pair for ${symbol}` }, { status: 404 });
        const interval = timeframeToBinanceInterval(tf);
        const klines = await binance.klines(pair, interval, 250);
        const ohlc = klines.map((k) => ({
          time: Math.floor(k.openTime / 1000),
          open: k.open, high: k.high, low: k.low, close: k.close,
          volume: k.volume,
        }));
        const hvf = analyzeHVF(ohlc);
        const lastClose = klines[klines.length - 1]?.close;
        return NextResponse.json({
          ok: true,
          pair,
          timeframe: interval,
          candles: klines.length,
          currentPrice: lastClose,
          hvf,
        });
      }

      case "buy": {
        if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
        if (!sizeUsd) return NextResponse.json({ error: "size (USDC) required" }, { status: 400 });
        const pair = binanceSymbol(symbol);
        if (!pair) return NextResponse.json({ error: `No USDC pair for ${symbol}` }, { status: 404 });
        const sizeNum = Number(sizeUsd);
        if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
          return NextResponse.json({ error: "size must be a positive number" }, { status: 400 });
        }
        const order = await binance.placeMarketOrder({
          symbol: pair, side: "BUY", quoteOrderQty: sizeNum,
        });
        return NextResponse.json({ ok: true, order });
      }

      case "sell": {
        if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
        if (!qty) return NextResponse.json({ error: "qty (base units) required" }, { status: 400 });
        const pair = binanceSymbol(symbol);
        if (!pair) return NextResponse.json({ error: `No USDC pair for ${symbol}` }, { status: 404 });
        const qtyNum = Number(qty);
        if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
          return NextResponse.json({ error: "qty must be a positive number" }, { status: 400 });
        }
        const order = await binance.placeMarketOrder({
          symbol: pair, side: "SELL", quantity: qtyNum,
        });
        return NextResponse.json({ ok: true, order });
      }

      case "pairs": {
        // Verify BINANCE_USDC_SYMBOL against live exchangeInfo. The map is
        // hand-maintained and drifts: a universe expansion that forgets to
        // add an entry here makes scanBinanceUniverse skip the asset in
        // silence, which is how DOT/ATOM/NEAR/INJ/SUI stayed invisible to
        // the Binance agent. Read-only.
        const cryptos = UNIVERSE.filter((u) => u.assetClass === "crypto");
        const checks = await Promise.all(
          cryptos.map(async (u) => {
            // Check the mapped pair, or the conventional one if unmapped —
            // an unmapped symbol whose pair DOES exist is a gap worth naming.
            const mapped = BINANCE_USDC_SYMBOL[u.symbol] ?? null;
            const candidate = mapped ?? `${u.symbol}USDC`;
            try {
              const info = await binance.exchangeInfo(candidate);
              const tradable = info.status === "TRADING";
              return {
                symbol: u.symbol,
                pair: candidate,
                mapped: mapped !== null,
                exists: true,
                status: info.status,
                verdict: mapped
                  ? (tradable ? "ok" : `MAPPED BUT NOT TRADING (${info.status})`)
                  : `UNMAPPED — pair exists${tradable ? " and is tradable; add it" : ` but status ${info.status}`}`,
              };
            } catch {
              return {
                symbol: u.symbol,
                pair: candidate,
                mapped: mapped !== null,
                exists: false,
                status: "not found",
                verdict: mapped
                  ? "MAPPED BUT PAIR DOES NOT EXIST — remove it"
                  : "no USDC pair (correctly unmapped)",
              };
            }
          }),
        );
        const problems = checks.filter((c) => c.verdict !== "ok" && !c.verdict.startsWith("no USDC pair"));
        // Log, don't just return: on the cron path nobody reads the body.
        // console.error so it stands out in Vercel runtime logs / alerts.
        if (problems.length > 0) {
          for (const p of problems) {
            console.error(`[binance-pairs] ${p.symbol} (${p.pair}): ${p.verdict}`);
          }
        } else {
          console.log(`[binance-pairs] all ${checks.length} crypto universe symbols verified against exchangeInfo`);
        }
        return NextResponse.json({
          ok: problems.length === 0,
          checked: checks.length,
          problems: problems.length,
          needsAttention: problems,
          all: checks.sort((a, b) => a.symbol.localeCompare(b.symbol)),
        });
      }

      case "open": {
        const orders = symbol
          ? await binance.openOrders(binanceSymbol(symbol) || symbol)
          : await binance.openOrders();
        return NextResponse.json({ ok: true, orders });
      }

      default:
        return NextResponse.json({
          error: `Unknown action: ${action}. Valid: ping, balances, scan, pairs, buy, sell, open`,
        }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
