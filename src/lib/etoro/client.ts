// eToro Public API client.
// Docs: https://api-portal.etoro.com/api-reference/
// Base URL: https://public-api.etoro.com/api/v1
//
// Auth (header-based, ALL endpoints require x-user-key):
//   x-api-key:     <ETORO_PUBLIC_KEY>     — single application key, both envs
//   x-user-key:    <ETORO_REAL_API_KEY | ETORO_PAPER_API_KEY> — per account
//   x-request-id:  uuid v4                — required, unique per request
//
// URL pattern: /trading/{info|execution}/{demo|real}/...
//   "demo" maps to our "paper" env label.
//
// Field convention: request bodies use PascalCase (InstrumentID, IsBuy,
// Amount, etc) per OpenAPI spec.
import { randomUUID } from "node:crypto";
import {
  EtoroCandle,
  EtoroEnv,
  EtoroInstrument,
  EtoroOpenPositionResult,
  EtoroPortfolio,
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

/**
 * Make an authed eToro request.
 * `env` MUST be supplied — eToro requires `x-user-key` on every endpoint,
 * including market-data. We default to paper when only doing market data
 * to avoid burning real-account quotas.
 */
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

/** /trading/info/{env}/pnl response — best-effort typing.
 *  Maps to our EtoroPortfolio shape. */
interface PnlResponse {
  credit?: number;
  positions?: Array<{
    positionID?: string | number;
    PositionID?: string | number;
    instrumentID?: number;
    InstrumentID?: number;
    isBuy?: boolean;
    IsBuy?: boolean;
    units?: number;
    Units?: number;
    openRate?: number;
    OpenRate?: number;
    amountInDollars?: number;
    AmountInDollars?: number;
    leverage?: number;
    Leverage?: number;
    stopLossRate?: number;
    StopLossRate?: number;
    takeProfitRate?: number;
    TakeProfitRate?: number;
    openDateTime?: string;
    OpenDateTime?: string;
    netProfit?: number;
    NetProfit?: number;
  }>;
  Positions?: PnlResponse["positions"];
  orders?: PnlResponse["positions"];
  Orders?: PnlResponse["positions"];
  totalRealizedEquity?: number;
  TotalRealizedEquity?: number;
  totalUnrealizedPnL?: number;
  TotalUnrealizedPnL?: number;
}

function normalizePosition<T extends Record<string, unknown>>(p: T): Record<string, unknown> {
  // eToro responses sometimes use PascalCase, sometimes camelCase.
  // Normalize to camelCase for our consumers.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    const camel = k.charAt(0).toLowerCase() + k.slice(1);
    out[camel] = v;
  }
  return out;
}

function normalizePnl(r: PnlResponse): EtoroPortfolio {
  const positions = (r.positions || r.Positions || []).map((p) => normalizePosition(p));
  const orders = (r.orders || r.Orders || []).map((o) => normalizePosition(o));
  return {
    credit: r.credit ?? 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    positions: positions as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orders: orders as any,
    totalRealizedEquity: r.totalRealizedEquity ?? r.TotalRealizedEquity,
    totalUnrealizedPnL: r.totalUnrealizedPnL ?? r.TotalUnrealizedPnL,
  };
}

// ────────────────────────────────────────────────────────────────────
// Public API surface
// ────────────────────────────────────────────────────────────────────

const SEARCH_FIELDS = "instrumentID,internalSymbolFull,instrumentDisplayName,instrumentTypeID,exchangeID,isActive,precision";

const CANDLE_PERIOD_MAP = {
  "OneMinute": "OneMinute",
  "OneHour": "OneHour",
  "OneDay": "OneDay",
  "OneWeek": "OneWeek",
} as const;

export const etoro = {
  // ── Portfolio + PnL ────────────────────────────────────────────
  async getPortfolio(env: EtoroEnv): Promise<EtoroPortfolio> {
    const raw = await request<PnlResponse>(env, `/trading/info/${envToPath(env)}/pnl`);
    return normalizePnl(raw);
  },

  // ── Market data (still needs x-user-key per docs) ──────────────
  async searchInstruments(query: string, env: EtoroEnv = "paper"): Promise<EtoroInstrument[]> {
    interface SearchResponse {
      instruments?: EtoroInstrument[];
      data?: EtoroInstrument[];
    }
    const data = await request<SearchResponse | EtoroInstrument[]>(env, "/market-data/search", {
      query: { searchText: query, fields: SEARCH_FIELDS, pageSize: 20 },
    });
    if (Array.isArray(data)) return data;
    return data.instruments || data.data || [];
  },

  async getRates(instrumentIds: number[], env: EtoroEnv = "paper"): Promise<EtoroRate[]> {
    if (instrumentIds.length === 0) return [];
    interface RatesResponse {
      rates?: EtoroRate[];
      data?: EtoroRate[];
    }
    const data = await request<RatesResponse | EtoroRate[]>(env, "/market-data/instruments/rates", {
      query: { instrumentIds: instrumentIds.join(",") },
    });
    if (Array.isArray(data)) return data;
    return data.rates || data.data || [];
  },

  async getCandles(
    instrumentId: number,
    period: keyof typeof CANDLE_PERIOD_MAP = "OneDay",
    count = 100,
    env: EtoroEnv = "paper",
  ): Promise<EtoroCandle[]> {
    const safeCount = Math.max(1, Math.min(1000, count));
    interface CandlesResponse {
      candles?: EtoroCandle[];
      data?: EtoroCandle[];
    }
    const path = `/market-data/instruments/${instrumentId}/history/candles/desc/${CANDLE_PERIOD_MAP[period]}/${safeCount}`;
    const data = await request<CandlesResponse | EtoroCandle[]>(env, path);
    const candles = Array.isArray(data) ? data : (data.candles || data.data || []);
    // eToro returns desc — we want asc (oldest → newest) for HVF analysis
    return [...candles].reverse();
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
    // eToro spec uses PascalCase
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
    const norm = normalizePosition(raw);
    return {
      positionID: String(norm.positionID ?? norm.positionId ?? ""),
      instrumentID: Number(norm.instrumentID ?? args.instrumentID),
      units: Number(norm.units ?? 0),
      openRate: Number(norm.openRate ?? 0),
      isBuy: Boolean(norm.isBuy ?? args.isBuy),
      amountInDollars: norm.amountInDollars as number | undefined,
      stopLossRate: norm.stopLossRate as number | undefined,
      takeProfitRate: norm.takeProfitRate as number | undefined,
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
    const norm = normalizePosition(raw);
    return { positionID: String(norm.positionID ?? norm.positionId ?? positionId) };
  },

  async modifyPosition(
    env: EtoroEnv,
    positionId: string,
    args: { stopLossRate?: number; takeProfitRate?: number; instrumentId: number },
  ): Promise<{ positionID: string }> {
    // Note: eToro "modify" path may differ — leaving best-guess until
    // we hit it in production. Update to match docs if 404.
    const body: Record<string, unknown> = { InstrumentID: args.instrumentId };
    if (args.stopLossRate !== undefined) body.StopLossRate = args.stopLossRate;
    if (args.takeProfitRate !== undefined) body.TakeProfitRate = args.takeProfitRate;
    const raw = await request<Record<string, unknown>>(
      env,
      `/trading/execution/${envToPath(env)}/positions/${encodeURIComponent(positionId)}/update`,
      { method: "POST", body },
    );
    const norm = normalizePosition(raw);
    return { positionID: String(norm.positionID ?? positionId) };
  },

  // ── Connectivity check ─────────────────────────────────────────
  async ping(env: EtoroEnv): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getPortfolio(env);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
