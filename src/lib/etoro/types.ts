// eToro Public API response types — derived from the docs at
// https://api-portal.etoro.com/. Marked partial because the API
// returns more fields than we use; we only type the ones we touch.

export type EtoroEnv = "real" | "paper";

/** Maps our env label to the URL segment eToro uses ("demo" for paper). */
export function envToPath(env: EtoroEnv): "demo" | "real" {
  return env === "paper" ? "demo" : "real";
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
