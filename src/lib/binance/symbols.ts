// Maps each agent universe symbol to its Binance Spot USDC pair.
// USDC because the user holds USDC. If a USDC pair doesn't exist on
// Binance for an asset, it's omitted here (agent can't trade it on
// Binance — falls back to eToro).
//
// To regenerate / verify:
//   curl 'https://api.binance.com/api/v3/exchangeInfo' \
//     | jq '.symbols[] | select(.quoteAsset=="USDC" and .status=="TRADING") | .symbol'

export const BINANCE_USDC_SYMBOL: Record<string, string> = {
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
