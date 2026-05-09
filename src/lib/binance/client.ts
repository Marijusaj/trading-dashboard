// Binance Spot REST client.
//
// Auth: API key in `X-MBX-APIKEY` header. Signed (private) endpoints
// add a `signature` query param: HMAC-SHA256(secret, queryString+body).
//
// Spot only — no margin, no futures. The agent can ONLY long on Binance
// (sell to close existing positions). The executor enforces this.

import { createHmac } from "node:crypto";

const BINANCE_BASE = "https://api.binance.com";

function apiKey(): string {
  const k = process.env.BINANCE_API_KEY;
  if (!k) throw new Error("Missing BINANCE_API_KEY env var");
  return k;
}
function apiSecret(): string {
  const s = process.env.BINANCE_API_SECRET;
  if (!s) throw new Error("Missing BINANCE_API_SECRET env var");
  return s;
}

function sign(qs: string): string {
  return createHmac("sha256", apiSecret()).update(qs).digest("hex");
}

interface SignedOpts {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  /** Recv window in ms (default 5000). Binance rejects requests older than this. */
  recvWindow?: number;
}

async function publicGet<T>(path: string, query?: Record<string, string | number>): Promise<T> {
  const url = new URL(BINANCE_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance ${path} ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

async function signedRequest<T>(path: string, params: Record<string, string | number>, opts: SignedOpts = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const recvWindow = opts.recvWindow ?? 5000;
  const ts = Date.now();
  const allParams = { ...params, recvWindow, timestamp: ts };
  const qs = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const signature = sign(qs);
  const fullQs = `${qs}&signature=${signature}`;

  let url = BINANCE_BASE + path;
  let body: string | undefined;
  const headers: Record<string, string> = {
    "X-MBX-APIKEY": apiKey(),
  };
  if (method === "GET" || method === "DELETE") {
    url = `${url}?${fullQs}`;
  } else {
    // Binance spot signed endpoints accept params in query string OR
    // in body — query string is simpler and avoids content-type quirks.
    url = `${url}?${fullQs}`;
  }

  const res = await fetch(url, { method, headers, body, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Binance ${method} ${path} ${res.status}: ${text.slice(0, 600)}`);
  }
  return res.json() as Promise<T>;
}

// ── Public types ───────────────────────────────────────────────────

export type BinanceInterval =
  | "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h"
  | "6h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";

export interface BinanceCandle {
  openTime: number;       // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

export interface BinanceBalance {
  asset: string;
  free: number;
  locked: number;
}

export interface BinanceAccount {
  accountType: string;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  balances: BinanceBalance[];
}

export interface BinanceOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  status: "NEW" | "FILLED" | "PARTIALLY_FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP_LOSS" | "STOP_LOSS_LIMIT" | "TAKE_PROFIT" | "TAKE_PROFIT_LIMIT" | "LIMIT_MAKER";
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;  // total quote currency spent (USDC)
  price: number;
  stopPrice: number;
  fills?: Array<{ price: number; qty: number; commission: number; commissionAsset: string }>;
}

// ── Client ──────────────────────────────────────────────────────────

export const binance = {
  /**
   * Server time + connectivity check. Public, no auth.
   * Useful as a smoke test before signed calls.
   */
  async ping(): Promise<{ serverTime: number; nowDriftMs: number }> {
    const out = await publicGet<{ serverTime: number }>("/api/v3/time");
    return { serverTime: out.serverTime, nowDriftMs: Date.now() - out.serverTime };
  },

  /**
   * GET /api/v3/exchangeInfo for one symbol. Returns trading rules
   * (lot size step, min notional, etc.) — important for sizing orders.
   */
  async exchangeInfo(symbol: string): Promise<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    filters: Array<Record<string, string>>;
  }> {
    interface Resp { symbols: Array<Record<string, unknown>> }
    const out = await publicGet<Resp>("/api/v3/exchangeInfo", { symbol });
    const s = out.symbols?.[0];
    if (!s) throw new Error(`Binance exchangeInfo: symbol ${symbol} not found`);
    return s as unknown as ReturnType<typeof binance.exchangeInfo> extends Promise<infer R> ? R : never;
  },

  /** Current ticker price. */
  async price(symbol: string): Promise<number> {
    const out = await publicGet<{ symbol: string; price: string }>("/api/v3/ticker/price", { symbol });
    return Number(out.price);
  },

  /**
   * Klines (candles). Returns ASC by openTime.
   *   limit: max 1000 per request.
   */
  async klines(symbol: string, interval: BinanceInterval, limit = 250): Promise<BinanceCandle[]> {
    interface RawKline extends Array<unknown> { 0: number; 1: string; 2: string; 3: string; 4: string; 5: string; 6: number; 7: string; 8: number }
    const out = await publicGet<RawKline[]>("/api/v3/klines", {
      symbol, interval, limit,
    });
    return out.map((k) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]),
      quoteVolume: Number(k[7]),
      trades: Number(k[8]),
    }));
  },

  /**
   * Account info — balances + permissions. Signed.
   * Filter zero balances for cleanliness.
   */
  async account(): Promise<BinanceAccount> {
    interface RawAcct {
      accountType: string;
      canTrade: boolean;
      canWithdraw: boolean;
      canDeposit: boolean;
      balances: Array<{ asset: string; free: string; locked: string }>;
    }
    const a = await signedRequest<RawAcct>("/api/v3/account", {});
    return {
      accountType: a.accountType,
      canTrade: a.canTrade,
      canWithdraw: a.canWithdraw,
      canDeposit: a.canDeposit,
      balances: (a.balances || [])
        .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
        .filter((b) => b.free > 0 || b.locked > 0),
    };
  },

  /**
   * Place a market order in QUOTE currency (USDC). For example
   * placeMarketBuy("TRXUSDC", 50) spends $50 USDC of TRX at market.
   * For spot, side="BUY" buys; side="SELL" sells held base asset.
   *
   * For SELL orders we use `quantity` (base asset units) — pass it via
   * the `quantity` arg. For BUY orders we use `quoteOrderQty` (USDC).
   */
  async placeMarketOrder(args: {
    symbol: string;
    side: "BUY" | "SELL";
    /** USDC amount for BUY orders */
    quoteOrderQty?: number;
    /** Base-asset quantity for SELL orders */
    quantity?: number;
    newClientOrderId?: string;
  }): Promise<BinanceOrder> {
    const params: Record<string, string | number> = {
      symbol: args.symbol,
      side: args.side,
      type: "MARKET",
    };
    if (args.side === "BUY") {
      if (!args.quoteOrderQty) throw new Error("BUY order requires quoteOrderQty (USDC)");
      params.quoteOrderQty = args.quoteOrderQty.toFixed(2);
    } else {
      if (!args.quantity) throw new Error("SELL order requires quantity (base units)");
      params.quantity = args.quantity;
    }
    if (args.newClientOrderId) params.newClientOrderId = args.newClientOrderId;

    interface RawOrder {
      symbol: string;
      orderId: number;
      clientOrderId: string;
      status: BinanceOrder["status"];
      side: BinanceOrder["side"];
      type: BinanceOrder["type"];
      origQty: string;
      executedQty: string;
      cummulativeQuoteQty: string;
      price: string;
      fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
    }
    const r = await signedRequest<RawOrder>("/api/v3/order", params, { method: "POST" });
    return {
      symbol: r.symbol,
      orderId: r.orderId,
      clientOrderId: r.clientOrderId,
      status: r.status,
      side: r.side,
      type: r.type,
      origQty: Number(r.origQty),
      executedQty: Number(r.executedQty),
      cummulativeQuoteQty: Number(r.cummulativeQuoteQty),
      price: Number(r.price),
      stopPrice: 0,
      fills: r.fills?.map((f) => ({
        price: Number(f.price),
        qty: Number(f.qty),
        commission: Number(f.commission),
        commissionAsset: f.commissionAsset,
      })),
    };
  },

  /** GET /api/v3/order — query a specific order by orderId. */
  async getOrder(symbol: string, orderId: number): Promise<BinanceOrder> {
    interface RawOrder {
      symbol: string;
      orderId: number;
      clientOrderId: string;
      status: BinanceOrder["status"];
      side: BinanceOrder["side"];
      type: BinanceOrder["type"];
      origQty: string;
      executedQty: string;
      cummulativeQuoteQty: string;
      price: string;
      stopPrice: string;
    }
    const r = await signedRequest<RawOrder>("/api/v3/order", { symbol, orderId });
    return {
      symbol: r.symbol, orderId: r.orderId, clientOrderId: r.clientOrderId,
      status: r.status, side: r.side, type: r.type,
      origQty: Number(r.origQty), executedQty: Number(r.executedQty),
      cummulativeQuoteQty: Number(r.cummulativeQuoteQty),
      price: Number(r.price), stopPrice: Number(r.stopPrice),
    };
  },

  /** Cancel an open order by orderId. */
  async cancelOrder(symbol: string, orderId: number): Promise<{ orderId: number; status: string }> {
    const r = await signedRequest<{ orderId: number; status: string }>(
      "/api/v3/order",
      { symbol, orderId },
      { method: "DELETE" },
    );
    return { orderId: r.orderId, status: r.status };
  },

  /** All currently-open orders for a symbol (or all symbols if omitted). */
  async openOrders(symbol?: string): Promise<BinanceOrder[]> {
    const params: Record<string, string | number> = {};
    if (symbol) params.symbol = symbol;
    interface Raw { symbol: string; orderId: number; clientOrderId: string; status: BinanceOrder["status"]; side: BinanceOrder["side"]; type: BinanceOrder["type"]; origQty: string; executedQty: string; cummulativeQuoteQty: string; price: string; stopPrice: string }
    const arr = await signedRequest<Raw[]>("/api/v3/openOrders", params);
    return arr.map((r) => ({
      symbol: r.symbol, orderId: r.orderId, clientOrderId: r.clientOrderId,
      status: r.status, side: r.side, type: r.type,
      origQty: Number(r.origQty), executedQty: Number(r.executedQty),
      cummulativeQuoteQty: Number(r.cummulativeQuoteQty),
      price: Number(r.price), stopPrice: Number(r.stopPrice),
    }));
  },
};
