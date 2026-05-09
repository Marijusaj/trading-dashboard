// Curated universe the agent is allowed to trade.
// Hard-coded list keeps the agent from venturing into obscure altcoins
// before we've verified eToro liquidity / tradability.
//
// Each entry maps a symbol to its eToro instrument ID. IDs are
// resolved on first use via the search endpoint and then cached
// in the `instruments` Neon table. The list below is the SEED.
//
// To change what the agent can trade: edit this list, NOT the
// agent prompt. The prompt is given the resolved universe at runtime.

export interface UniverseEntry {
  symbol: string;          // eToro internal symbol (e.g. "BTC", "ETH")
  display: string;
  assetClass: "crypto" | "commodity" | "equity" | "etf";
  // Hint we pass to Claude — explains why this is in the universe
  thesis: string;
  // Whether the agent can SHORT this on eToro (some equities are long-only)
  shortAllowed: boolean;
  // Optional pre-resolved instrument ID. Will be discovered if null.
  instrumentId: number | null;
  // eToro min position size in USD per asset class (CFDs require $1000+)
  // crypto: ~$10, commodity/equity CFDs (when leveraged): $1000
  minSizeUsd: number;
}

export const UNIVERSE: UniverseEntry[] = [
  // ── Major crypto (low min: $10) ────────────────────────────────
  { symbol: "BTC", display: "Bitcoin", assetClass: "crypto", thesis: "Macro bellwether — Francis bear flag thesis active", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "ETH", display: "Ethereum", assetClass: "crypto", thesis: "Underperforming BTC, weak technicals per Francis", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "TRX", display: "Tron", assetClass: "crypto", thesis: "Stablecoin rail thesis, $0.33 breakout watch", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "SOL", display: "Solana", assetClass: "crypto", thesis: "Bear flag, -37% target per Francis", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "XRP", display: "Ripple", assetClass: "crypto", thesis: "Broken support, sub-$1 target", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "BNB", display: "BNB", assetClass: "crypto", thesis: "Major exchange token, follows BTC", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "ADA", display: "Cardano", assetClass: "crypto", thesis: "Technically weak per Francis", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "DOGE", display: "Dogecoin", assetClass: "crypto", thesis: "High beta, Musk sentiment", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },
  { symbol: "AVAX", display: "Avalanche", assetClass: "crypto", thesis: "L1 competitor — SHORTS DISALLOWED on this eToro account (errorCode 747); long-only", shortAllowed: false, instrumentId: null, minSizeUsd: 10 },
  { symbol: "LINK", display: "Chainlink", assetClass: "crypto", thesis: "Oracle infrastructure", shortAllowed: true, instrumentId: null, minSizeUsd: 10 },

  // ── Commodity CFDs (min $1000 due to leverage requirement) ─────
  { symbol: "GOLD", display: "Gold", assetClass: "commodity", thesis: "Debasement hedge, $24K Francis target", shortAllowed: true, instrumentId: null, minSizeUsd: 1000 },
  { symbol: "SILVER", display: "Silver", assetClass: "commodity", thesis: "Higher beta gold play", shortAllowed: true, instrumentId: null, minSizeUsd: 1000 },

  // ── Equity / ETF (min $50 typical) ─────────────────────────────
  { symbol: "MSTR", display: "Strategy Inc", assetClass: "equity", thesis: "Levered BTC exposure (Saylor)", shortAllowed: true, instrumentId: null, minSizeUsd: 50 },
  { symbol: "COIN", display: "Coinbase", assetClass: "equity", thesis: "Crypto exchange beta", shortAllowed: true, instrumentId: null, minSizeUsd: 50 },
  { symbol: "GLD", display: "SPDR Gold ETF", assetClass: "etf", thesis: "Gold ETF for accounts without futures access", shortAllowed: true, instrumentId: null, minSizeUsd: 50 },
];

export function getUniverseSymbols(): string[] {
  return UNIVERSE.map((u) => u.symbol);
}

export function getUniverseEntry(symbol: string): UniverseEntry | undefined {
  return UNIVERSE.find((u) => u.symbol === symbol);
}
