// eToro Public API client.
// Docs: https://api-portal.etoro.com/
//
// Auth (header-based):
//   x-api-key:     <ETORO_PUBLIC_KEY>     — single application key, both envs
//   x-user-key:    <ETORO_REAL_API_KEY | ETORO_PAPER_API_KEY> — per account
//   x-request-id:  uuid v4                — required, unique per request
//
// URL pattern: /trading/{demo|real}/...
//   "demo" maps to our "paper" env label.
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
    super(`eToro ${status} on ${endpoint}: ${message}`);
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
  // Retry on 429/5xx
  retries?: number;
}

async function request<T>(
  env: EtoroEnv | null,           // null = market-data endpoints (no env)
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
    "x-request-id": randomUUID(),
    "Accept": "application/json",
  };
  if (env) headers["x-user-key"] = userKeyFor(env);
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
      // Some DELETE endpoints return empty body
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

    // Retry on 429 (rate limited) or 5xx
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
// Public API surface
// ────────────────────────────────────────────────────────────────────

export const etoro = {
  // ── Portfolio (per-env) ────────────────────────────────────────
  async getPortfolio(env: EtoroEnv): Promise<EtoroPortfolio> {
    return request<EtoroPortfolio>(env, `/trading/${envToPath(env)}/portfolio`);
  },

  // ── Market data (no env required) ──────────────────────────────
  async searchInstruments(query: string): Promise<EtoroInstrument[]> {
    const data = await request<{ instruments?: EtoroInstrument[] } | EtoroInstrument[]>(
      null,
      "/market-data/search",
      { query: { internalSymbolFull: query } },
    );
    if (Array.isArray(data)) return data;
    return data.instruments || [];
  },

  async getRates(instrumentIds: number[]): Promise<EtoroRate[]> {
    if (instrumentIds.length === 0) return [];
    const data = await request<{ rates?: EtoroRate[] } | EtoroRate[]>(
      null,
      "/market-data/rates",
      { query: { instrumentIds: instrumentIds.join(",") } },
    );
    if (Array.isArray(data)) return data;
    return data.rates || [];
  },

  async getCandles(
    instrumentId: number,
    period: "OneMinute" | "OneHour" | "OneDay" | "OneWeek" = "OneDay",
    count = 100,
  ): Promise<EtoroCandle[]> {
    const data = await request<{ candles?: EtoroCandle[] } | EtoroCandle[]>(
      null,
      "/market-data/candles",
      { query: { instrumentId, period, count } },
    );
    if (Array.isArray(data)) return data;
    return data.candles || [];
  },

  // ── Trading (per-env) — guarded by agent layer, NOT directly exposed
  // to user-facing endpoints. Always called from /lib/agent/execute.ts.
  async openPositionByAmount(
    env: EtoroEnv,
    args: {
      instrumentID: number;
      isBuy: boolean;          // false = short
      amount: number;          // USD
      leverage?: number;
      stopLossRate: number;    // REQUIRED by our guardrails
      takeProfitRate: number;  // REQUIRED
    },
  ): Promise<EtoroOpenPositionResult> {
    return request<EtoroOpenPositionResult>(
      env,
      `/trading/${envToPath(env)}/open-position-by-amount`,
      { method: "POST", body: args },
    );
  },

  async closePosition(env: EtoroEnv, positionId: string): Promise<{ positionID: string }> {
    return request<{ positionID: string }>(
      env,
      `/trading/${envToPath(env)}/close-position`,
      { method: "POST", body: { positionID: positionId } },
    );
  },

  async modifyPosition(
    env: EtoroEnv,
    positionId: string,
    args: { stopLossRate?: number; takeProfitRate?: number },
  ): Promise<{ positionID: string }> {
    return request<{ positionID: string }>(
      env,
      `/trading/${envToPath(env)}/modify-position`,
      { method: "POST", body: { positionID: positionId, ...args } },
    );
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
