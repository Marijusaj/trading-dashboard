// eToro Public API client.
// Docs: https://api-portal.etoro.com/api-reference/
// Base URL: https://public-api.etoro.com/api/v1
//
// Auth (header-based, ALL endpoints require x-user-key):
//   x-api-key:     <ETORO_PUBLIC_KEY>     — single application key, both envs
//   x-user-key:    <ETORO_REAL_API_KEY | ETORO_PAPER_API_KEY> — per account
//   x-request-id:  uuid v4                — required, unique per request
//
// Field convention: request bodies use PascalCase (InstrumentID, IsBuy, etc).
// Response field naming is INCONSISTENT — many use uppercase ID
// (instrumentID, positionID), some use lowercase d (instrumentId).
// Each parser below is hand-tuned to the actual response shape we observed.
import { randomUUID } from "node:crypto";
import {
  EtoroCandle,
  EtoroEnv,
  EtoroOpenPositionResult,
  EtoroPortfolio,
  EtoroPosition,
  EtoroRate,
  envToPath,
} from "./types";

const BASE_URL = "https://public-api.etoro.com/api/v1";

export class EtoroAPIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: string,
  ) {
    super(`eToro ${status} on ${endpoint}: ${message} | body=${body.slice(0, 200)}`);
  }
}

function userKeyFor(env: EtoroEnv): string {
  const key = env === "real" ? process.env.ETORO_REAL_API_KEY : process.env.ETORO_PAPER_API_KEY;
  if (!key) {
    throw new Error(`Missing ${env === "real" ? "ETORO_REAL_API_KEY" : "ETORO_PAPER_API_KEY"} env var`);
  }
  return key;
}

function publicKey(): string {
  const k = process.env.ETORO_PUBLIC_KEY;
  if (!k) throw new Error("Missing ETORO_PUBLIC_KEY env var");
  return k;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  retries?: number;
}

async function request<T>(
  env: EtoroEnv,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, query, retries = 2 } = opts;

  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    "x-api-key": publicKey(),
    "x-user-key": userKeyFor(env),
    "x-request-id": randomUUID(),
    "Accept": "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let lastErr: EtoroAPIError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });

    if (res.ok) {
      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new EtoroAPIError("Invalid JSON in response", res.status, path, text);
      }
    }

    const errBody = await res.text();
    lastErr = new EtoroAPIError(
      res.statusText || "Request failed",
      res.status,
      path,
      errBody.slice(0, 500),
    );

    if (attempt < retries && (res.status === 429 || res.status >= 500)) {
      const backoffMs = 500 * Math.pow(2, attempt) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    break;
  }

  throw lastErr!;
}

// ────────────────────────────────────────────────────────────────────
// Response shapes that differ from our domain types
// ────────────────────────────────────────────────────────────────────

interface RawPnlPosition {
  positionID?: number | string;
  instrumentID: number;
  isBuy: boolean;
  units: number;
  openRate: number;
  amount: number;                  // USD committed
  initialAmountInDollars?: number;
  leverage?: number;
  stopLossRate?: number;
  takeProfitRate?: number;
  openDateTime: string;
  unrealizedPnL?: {
    pnL?: number;
    pnlAssetCurrency?: number;
    closeRate?: number;
    timestamp?: string;
  };
}

interface PnlResponse {
  clientPortfolio?: {
    credit?: number;                     // available cash
    unrealizedPnL?: number;
    accountCurrencyId?: number;
    positions?: RawPnlPosition[];
    mirrors?: { positions?: RawPnlPosition[] }[];
    orders?: unknown[];
    stockOrders?: unknown[];
    entryOrders?: unknown[];
    exitOrders?: unknown[];
  };
}

function rawPositionToDomain(p: RawPnlPosition): EtoroPosition {
  return {
    positionID: String(p.positionID ?? ""),
    instrumentID: Number(p.instrumentID),
    isBuy: !!p.isBuy,
    units: Number(p.units ?? 0),
    openRate: Number(p.openRate ?? 0),
    amountInDollars: Number(p.amount ?? p.initialAmountInDollars ?? 0),
    leverage: Number(p.leverage ?? 1),
    stopLossRate: p.stopLossRate,
    takeProfitRate: p.takeProfitRate,
    openDateTime: p.openDateTime,
    netProfit: p.unrealizedPnL?.pnL,
  };
}

interface SearchResponse {
  page?: number;
  pageSize?: number;
  totalItems?: number;
  items?: Array<Record<string, unknown>>;
}

interface RatesResponse {
  rates?: Array<{
    instrumentID: number;
    ask: number;
    bid: number;
    lastExecution?: number;
    date?: string;
  }>;
}

interface CandlesResponse {
  interval?: string;
  candles?: Array<{
    instrumentId: number;
    candles?: Array<{
      instrumentID: number;
      fromDate: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number | null;
    }>;
    rangeOpen?: number;
    rangeClose?: number;
    rangeHigh?: number;
    rangeLow?: number;
  }>;
}

export interface InstrumentMeta {
  instrumentID: number;
  instrumentDisplayName: string;
  instrumentTypeID: number;
  exchangeID?: number;
  symbolFull: string;
  isInternalInstrument?: boolean;
}

interface InstrumentsListResponse {
  instrumentDisplayDatas?: InstrumentMeta[];
  total?: number;
  totalItems?: number;
  pageNumber?: number;
  pageSize?: number;
}

// ────────────────────────────────────────────────────────────────────
// Public API surface
// ────────────────────────────────────────────────────────────────────

const CANDLE_PERIOD_MAP = {
  OneMinute: "OneMinute",
  OneHour: "OneHour",
  OneDay: "OneDay",
  OneWeek: "OneWeek",
} as const;

const RATES_BATCH_SIZE = 5;  // Larger batches occasionally 500

export const etoro = {
  // ── Portfolio ──────────────────────────────────────────────────
  /**
   * GET /trading/info/{env}/pnl returns:
   *   { clientPortfolio: { credit, unrealizedPnL, positions[], mirrors[], orders[], ... } }
   * We flatten to our domain EtoroPortfolio shape and unwrap mirror positions.
   */
  async getPortfolio(env: EtoroEnv): Promise<EtoroPortfolio> {
    const raw = await request<PnlResponse>(env, `/trading/info/${envToPath(env)}/pnl`);
    const cp = raw.clientPortfolio || {};
    const positions = cp.positions || [];
    const mirrorPositions = (cp.mirrors || []).flatMap((m) => m.positions || []);
    return {
      credit: Number(cp.credit ?? 0),
      positions: [...positions, ...mirrorPositions].map(rawPositionToDomain),
      orders: [],
      totalUnrealizedPnL: cp.unrealizedPnL,
    };
  },

  // ── Market data ────────────────────────────────────────────────
  /**
   * The /market-data/search endpoint mostly returns market-summary rows
   * and does NOT reliably return real instruments by symbol. Use the
   * paginated /market-data/instruments list for discovery instead.
   *
   * Kept here only as a debugging/exploration helper.
   */
  async searchInstruments(query: string, env: EtoroEnv = "paper"): Promise<InstrumentMeta[]> {
    const data = await request<SearchResponse>(env, "/market-data/search", {
      query: { searchText: query, pageSize: 25 },
    });
    return (data.items || [])
      .filter((it) => it.isHiddenFromClient !== true && Number(it.instrumentId) > 0)
      .map((it) => ({
        instrumentID: Number(it.internalInstrumentId ?? it.instrumentId),
        instrumentDisplayName: String(it.internalInstrumentDisplayName ?? it.instrumentDisplayName ?? ""),
        instrumentTypeID: Number(it.internalAssetClassId ?? it.instrumentTypeID ?? 0),
        symbolFull: String(it.internalSymbolFull ?? it.symbolFull ?? ""),
        isInternalInstrument: !!it.isInternalInstrument,
      }));
  },

  /**
   * GET /market-data/instruments — proper instrument discovery.
   *
   * eToro has ~11k instruments. Sequential pagination is slow.
   * Strategy: fetch page 1 to learn `totalItems`, then dispatch the
   * remaining pages in parallel (limited concurrency).
   *
   * If `stopWhen` is provided and returns true mid-batch, we still
   * await the in-flight requests but skip remaining pages. Useful
   * when callers only need a few instruments.
   */
  async listInstruments(
    env: EtoroEnv = "paper",
    pageSize = 500,
    stopWhen?: (items: InstrumentMeta[]) => boolean,
  ): Promise<InstrumentMeta[]> {
    const first = await request<InstrumentsListResponse>(env, "/market-data/instruments", {
      query: { pageSize, pageNumber: 1 },
    });
    const all = (first.instrumentDisplayDatas || []).slice();

    if (stopWhen && stopWhen(all)) return all;

    const total = first.totalItems ?? first.total ?? all.length;
    const pages = Math.min(50, Math.ceil(total / pageSize));
    if (pages <= 1) return all;

    const concurrency = 6;
    let nextPage = 2;
    let stopped = false;

    async function worker() {
      while (!stopped) {
        const p = nextPage++;
        if (p > pages) return;
        try {
          const data = await request<InstrumentsListResponse>(env, "/market-data/instruments", {
            query: { pageSize, pageNumber: p },
          });
          const batch = data.instrumentDisplayDatas || [];
          all.push(...batch);
          if (stopWhen && stopWhen(all)) stopped = true;
        } catch (e) {
          console.warn("listInstruments page failed", p, e);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return all;
  },

  /**
   * GET /market-data/instruments/rates?instrumentIds=1,2,3
   * Returns { rates: [{ instrumentID, ask, bid, ... }] }
   * Larger batches sometimes 500 — we chunk into RATES_BATCH_SIZE.
   */
  async getRates(instrumentIds: number[], env: EtoroEnv = "paper"): Promise<EtoroRate[]> {
    if (instrumentIds.length === 0) return [];
    const chunks: number[][] = [];
    for (let i = 0; i < instrumentIds.length; i += RATES_BATCH_SIZE) {
      chunks.push(instrumentIds.slice(i, i + RATES_BATCH_SIZE));
    }
    const results: EtoroRate[] = [];
    for (const chunk of chunks) {
      try {
        const data = await request<RatesResponse>(env, "/market-data/instruments/rates", {
          query: { instrumentIds: chunk.join(",") },
        });
        for (const r of data.rates || []) {
          results.push({
            instrumentID: r.instrumentID,
            bid: r.bid,
            ask: r.ask,
            close: r.lastExecution,
            ts: r.date,
          });
        }
      } catch (e) {
        // Skip the bad chunk, keep going
        console.warn("rates chunk failed", chunk, e);
      }
    }
    return results;
  },

  /**
   * GET /market-data/instruments/{id}/history/candles/{direction}/{interval}/{count}
   * Returns: { interval, candles: [{ instrumentId, candles: [...bars...] }] }
   * Bars come in `desc` order; we always reverse to ASC for HVF analysis.
   */
  async getCandles(
    instrumentId: number,
    period: keyof typeof CANDLE_PERIOD_MAP = "OneDay",
    count = 100,
    env: EtoroEnv = "paper",
  ): Promise<EtoroCandle[]> {
    const safeCount = Math.max(1, Math.min(1000, count));
    const path = `/market-data/instruments/${instrumentId}/history/candles/desc/${CANDLE_PERIOD_MAP[period]}/${safeCount}`;
    const data = await request<CandlesResponse>(env, path);
    const inner = data.candles?.[0]?.candles || [];
    // ASC order for downstream consumers
    return inner
      .slice()
      .reverse()
      .map((c) => ({
        fromDate: c.fromDate,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
  },

  // ── Trading ────────────────────────────────────────────────────
  async openPositionByAmount(
    env: EtoroEnv,
    args: {
      instrumentID: number;
      isBuy: boolean;
      amount: number;
      leverage?: number;
      stopLossRate: number;
      takeProfitRate: number;
    },
  ): Promise<EtoroOpenPositionResult> {
    const body = {
      InstrumentID: args.instrumentID,
      IsBuy: args.isBuy,
      Leverage: args.leverage ?? 1,
      Amount: args.amount,
      StopLossRate: args.stopLossRate,
      TakeProfitRate: args.takeProfitRate,
    };
    const raw = await request<Record<string, unknown>>(
      env,
      `/trading/execution/${envToPath(env)}/market-open-orders/by-amount`,
      { method: "POST", body },
    );
    return {
      positionID: String(raw.positionID ?? raw.PositionID ?? ""),
      instrumentID: Number(raw.instrumentID ?? raw.InstrumentID ?? args.instrumentID),
      units: Number(raw.units ?? raw.Units ?? 0),
      openRate: Number(raw.openRate ?? raw.OpenRate ?? 0),
      isBuy: Boolean(raw.isBuy ?? raw.IsBuy ?? args.isBuy),
      amountInDollars: (raw.amount as number | undefined) ?? args.amount,
      stopLossRate: raw.stopLossRate as number | undefined,
      takeProfitRate: raw.takeProfitRate as number | undefined,
    };
  },

  async closePosition(
    env: EtoroEnv,
    positionId: string,
    instrumentId: number,
    unitsToDeduct?: number,
  ): Promise<{ positionID: string }> {
    const body: Record<string, unknown> = { InstrumentID: instrumentId };
    if (unitsToDeduct !== undefined) body.UnitsToDeduct = unitsToDeduct;
    const raw = await request<Record<string, unknown>>(
      env,
      `/trading/execution/${envToPath(env)}/market-close-orders/positions/${encodeURIComponent(positionId)}`,
      { method: "POST", body },
    );
    return { positionID: String(raw.positionID ?? raw.PositionID ?? positionId) };
  },

  // ── Connectivity check ─────────────────────────────────────────
  async ping(env: EtoroEnv): Promise<{ ok: boolean; error?: string; credit?: number; positions?: number }> {
    try {
      const p = await this.getPortfolio(env);
      return { ok: true, credit: p.credit, positions: p.positions.length };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
