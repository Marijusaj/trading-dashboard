// eToro Public API response types — derived from the docs at
// https://api-portal.etoro.com/. Marked partial because the API
// returns more fields than we use; we only type the ones we touch.

// EtoroEnv historically was "real" | "paper". With the addition of
// 'binance' to AgentEnvironment, eToro client functions now accept the
// wider type and assert at runtime. This avoids cluttering 17+ call
// sites with explicit narrowing — the assertion lives at the boundary.
import type { AgentEnvironment } from "@/lib/neon";
export type EtoroEnv = AgentEnvironment;

function assertEtoro(env: EtoroEnv): void {
  if (env === "binance") {
    throw new Error(`eToro client called with env=binance — Binance trades route through @/lib/binance, not @/lib/etoro`);
  }
}

/** Maps our env label to the URL segment eToro uses ("demo" for paper). */
export function envToPath(env: EtoroEnv): "demo" | "real" {
  assertEtoro(env);
  return env === "paper" ? "demo" : "real";
}

/**
 * eToro execution endpoints have an asymmetric URL convention:
 *   - Paper/demo: /trading/execution/demo/market-open-orders/by-amount
 *   - Real:       /trading/execution/market-open-orders/by-amount  (no env segment)
 *
 * Info endpoints (/trading/info/{env}/pnl) accept both "demo" and "real",
 * but execution endpoints return 404 RouteNotFound when "real" is included.
 *
 * Returns the segment INCLUDING the trailing slash, or empty string for real.
 * Use for placeMarketOrder, closePosition, cancelOrder paths.
 */
export function envToExecPathSegment(env: EtoroEnv): "demo/" | "" {
  assertEtoro(env);
  return env === "paper" ? "demo/" : "";
}

export interface EtoroInstrument {
  instrumentID: number;
  internalSymbolFull: string;
  instrumentDisplayName: string;
  exchangeID?: number;
  industryID?: number;
  isActive?: boolean;
  precision?: number;
  // We map this to our own asset_class
  instrumentTypeID?: number;
}

export interface EtoroRate {
  instrumentID: number;
  bid: number;
  ask: number;
  // Some endpoints return last-trade price or close
  close?: number;
  ts?: string;
}

export interface EtoroCandle {
  fromDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Bar volume. eToro returns null for some instruments/timeframes, so
   *  consumers must treat this as optional — HVF scores the volume leg
   *  neutral when it isn't fully populated. */
  volume?: number | null;
}

export interface EtoroPosition {
  positionID: string;
  instrumentID: number;
  isBuy: boolean;            // true = long, false = short
  units: number;
  openRate: number;          // entry price
  amountInDollars?: number;  // cash committed (initial margin)
  leverage?: number;
  stopLossRate?: number;
  takeProfitRate?: number;
  openDateTime: string;
  // PnL helpers — present in some responses
  netProfit?: number;
  amountInUSD?: number;
}

export interface EtoroOrder {
  orderID: string;
  instrumentID: number;
  isBuy: boolean;
  units?: number;
  amount?: number;
  rate?: number;
  stopLossRate?: number;
  takeProfitRate?: number;
  orderDateTime: string;
  orderType: string;
}

export interface EtoroPortfolio {
  credit: number;            // available cash
  positions: EtoroPosition[];
  orders: EtoroOrder[];
  // PnL details — exact shape varies by endpoint
  totalRealizedEquity?: number;
  totalUnrealizedPnL?: number;
}

export interface EtoroOpenPositionResult {
  positionID: string;
  instrumentID: number;
  units: number;
  openRate: number;
  isBuy: boolean;
  amountInDollars?: number;
  stopLossRate?: number;
  takeProfitRate?: number;
}

/** Result of placing a market order — order goes into a queue first.
 *  The agent receives this immediately, then polls for terminal state. */
export interface EtoroOrderPlacement {
  orderID: string;
  initialStatusID: number;
  amountQueued: number;
  unitsQueued: number;
}

/** Detailed order info from /trading/info/{env}/orders/{orderId}.
 *
 * statusID is unreliable as a single source of truth — observed values:
 *   0  = Pending (queued, not yet processed)
 *   1  = Executed (sometimes; not always present even when filled)
 *   2  = Cancelled (user-cancelled or system-cancelled with no fill)
 *   3  = Reported as "Rejected" in docs BUT in practice often appears
 *        when an order has been COMPLETED/FILLED with a position created.
 *   4  = Partially Executed
 *   11 = Pending market open (CFD weekend queue)
 *
 * The reliable signal is the `positions[]` array combined with
 * `errorCode`. If `positions[0].isOpen=true` and errorCode=0, the
 * order produced an open position regardless of statusID.
 */
export interface EtoroOrderInfo {
  orderID: string;
  instrumentID: number;
  amount: number;
  units: number;
  statusID: number;
  errorCode: number;
  errorMessage?: string;
  positionID?: string | null;        // populated when a position exists
  openRate?: number | null;          // entry rate of the produced position
  positionIsOpen?: boolean;          // true if positions[0].isOpen
  requestOccurred?: string;
}
