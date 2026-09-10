// Maps each agent universe symbol to its Binance Spot USDC pair.
// USDC because the user holds USDC. If a USDC pair doesn't exist on
// Binance for an asset, it's omitted here (agent can't trade it on
// Binance — falls back to eToro).
//
// To regenerate / verify:
//   curl 'https://api.binance.com/api/v3/exchangeInfo' \
//     | jq '.symbols[] | select(.quoteAsset=="USDC" and .status=="TRADING") | .symbol'

export const BINANCE_USDC_SYMBOL: Record<string, string> = {
  // ── Verified against exchangeInfo ──────────────────────────────
  BTC: "BTCUSDC",
  ETH: "ETHUSDC",
  TRX: "TRXUSDC",
  SOL: "SOLUSDC",
  XRP: "XRPUSDC",
  BNB: "BNBUSDC",
  ADA: "ADAUSDC",
  DOGE: "DOGEUSDC",
  AVAX: "AVAXUSDC",
  LINK: "LINKUSDC",

  // ── NOT yet verified against exchangeInfo ──────────────────────
  // The May 2026 universe expansion added DOT/ATOM/NEAR/INJ/SUI to
  // UNIVERSE but never here, so scanBinanceUniverse silently skipped all
  // five — the Binance agent has never seen them. XLM is new to the
  // universe. These follow the <BASE>USDC convention every verified pair
  // above uses, but the listings could not be confirmed from the machine
  // that added them (api.binance.com answers HTTP 451 outside eligible
  // regions), so treat them as provisional.
  //
  // Confirm with:  GET /api/admin/binance?action=pairs
  // which checks every universe symbol against live exchangeInfo and
  // reports mapped-but-missing pairs. Delete any line it flags.
  //
  // Failure mode if a pair does not exist is identical to leaving the
  // symbol unmapped: binance.klines throws, scanBinanceUniverse catches
  // per-asset and returns null, so the symbol is skipped with a warning.
  XLM: "XLMUSDC",
  DOT: "DOTUSDC",
  ATOM: "ATOMUSDC",
  NEAR: "NEARUSDC",
  INJ: "INJUSDC",
  SUI: "SUIUSDC",
};

/**
 * Returns the Binance USDC pair for a universe symbol, or null if
 * no USDC pair exists (agent must skip this symbol on Binance).
 */
export function binanceSymbol(universeSymbol: string): string | null {
  return BINANCE_USDC_SYMBOL[universeSymbol.toUpperCase()] ?? null;
}

/**
 * Returns the underlying universe symbol for a Binance pair, or null
 * if it's not in our map. E.g. binanceToUniverse("TRXUSDC") -> "TRX".
 */
export function binanceToUniverse(binancePair: string): string | null {
  for (const [sym, pair] of Object.entries(BINANCE_USDC_SYMBOL)) {
    if (pair === binancePair) return sym;
  }
  return null;
}

/**
 * Maps our internal HVF timeframe label to the Binance Klines interval enum.
 * Binance interval strings differ from eToro's (Binance: "15m", eToro: "FifteenMinutes").
 */
export function timeframeToBinanceInterval(tf: string): "15m" | "1h" | "4h" | "1d" {
  switch (tf) {
    case "15m": return "15m";
    case "1h":  return "1h";
    case "4h":  return "4h";
    case "1d":
    default:    return "1d";
  }
}
