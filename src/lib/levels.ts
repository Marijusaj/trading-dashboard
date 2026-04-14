// CryptoSniper (Francis Hunt) Key Levels — March 2026 Analysis

export const BTC_LEVELS = [
  { price: 47500, label: "H&S Neckline", color: "#ff9800", description: "Head & Shoulders neckline from 64K/69K cycle. Expect bounce." },
  { price: 46550, label: "Bear Flag #1", color: "#f44336", description: "Bear flag measured move target #1." },
  { price: 37000, label: "Geometric Target", color: "#e91e63", description: "Geometric/log scale bear flag target #2." },
  { price: 35000, label: "H&S Target", color: "#9c27b0", description: "Head & Shoulders pattern target. Maximum bearish confluence." },
];

export const TRX_LEVELS = [
  { price: 0.3066, label: "Stop Loss", color: "#f44336", description: "Position stop loss. Below = exit." },
  { price: 0.31, label: "W-Bottom Neckline", color: "#4caf50", description: "W-bottom neckline / key support. Below = thesis breaks." },
  { price: 0.32, label: "BREAKOUT LEVEL", color: "#ff9800", description: "Key resistance. Daily close above = SIGNAL ON. Add size." },
  { price: 0.34, label: "Confirm Level", color: "#ffeb3b", description: "Above here = breakout confirmed. Full conviction." },
  { price: 0.38, label: "W Bottom Target", color: "#8bc34a", description: "W-bottom measured move target." },
  { price: 0.50, label: "Macro Target", color: "#00e676", description: "Macro stablecoin thesis target." },
];

export const PAIR_INFO = {
  targetRatio: 0.00001697,
  currentApprox: 0.00000455,
  multiplier: 3.7,
  description: "TRX/BTC inverted H&S breakout. Target ~3.7x outperformance.",
};
