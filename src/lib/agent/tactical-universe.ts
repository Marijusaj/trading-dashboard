// Tactical agent universe — 5 high-volatility cryptos for 15-min HVF setups.
// Smaller min sizes than strategic since tactical takes smaller positions.
import type { UniverseEntry } from "./universe";

export const TACTICAL_UNIVERSE: UniverseEntry[] = [
  {
    symbol: "SOL",
    display: "Solana",
    assetClass: "crypto",
    thesis: "High-beta L1 — frequent 15m squeezes",
    shortAllowed: true,
    instrumentId: null,  // resolved from Neon cache
    minSizeUsd: 10,
  },
  {
    symbol: "AVAX",
    display: "Avalanche",
    assetClass: "crypto",
    thesis: "L1 with intraday volatility, tracks SOL beta",
    // eToro errorCode 747 observed 2026-04-27: 'opening position is disallowed
    // for Sell positions of this instrument'. Account/jurisdiction restriction.
    shortAllowed: false,
    instrumentId: null,
    minSizeUsd: 10,
  },
  {
    symbol: "DOGE",
    display: "Dogecoin",
    assetClass: "crypto",
    thesis: "High retail flow, sharp 15m moves on news",
    shortAllowed: true,
    instrumentId: null,
    minSizeUsd: 10,
  },
  {
    symbol: "BNB",
    display: "BNB",
    assetClass: "crypto",
    thesis: "Major exchange token, follows BTC with 15m alpha",
    shortAllowed: true,
    instrumentId: null,
    minSizeUsd: 10,
  },
  {
    symbol: "LINK",
    display: "Chainlink",
    assetClass: "crypto",
    thesis: "Oracle infra, clean 15m HVF setups historically",
    shortAllowed: true,
    instrumentId: null,
    minSizeUsd: 10,
  },
];

// Position sizing for tactical (smaller than strategic)
export const TACTICAL_LIMITS = {
  real: {
    maxPositionSizeUsd: 25,    // half of strategic Real ($50)
    minRewardRiskRatio: 1.5,
    maxLeverage: 1,
  },
  paper: {
    maxPositionSizeUsd: 1000,  // 20% of strategic Paper ($5000)
    minRewardRiskRatio: 1.5,
    maxLeverage: 2,
  },
};
