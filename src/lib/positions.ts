// Active positions — update here when you open/close trades
// This avoids needing API keys on the public dashboard

export interface Position {
  symbol: string;
  pair: string;
  side: "long" | "short";
  entryPrice: number;
  amount: number;
  costBasis: number;
  entryDate: string;
  stopLoss: number;
  targets: { price: number; label: string }[];
  exchange: string;
  status: "open" | "closed";
}

export const POSITIONS: Position[] = [
  {
    symbol: "TRX",
    pair: "TRX/USDC",
    side: "long",
    entryPrice: 0.3227,
    amount: 339.68,
    costBasis: 109.72,
    entryDate: "2026-04-12",
    stopLoss: 0.3066,
    targets: [
      { price: 0.35, label: "RH3 Target" },
      { price: 0.50, label: "Macro Target" },
    ],
    exchange: "Binance",
    status: "open",
  },
];

// BTC short is manual on eToro — track here when opened
// {
//   symbol: "BTC",
//   pair: "BTC/USD",
//   side: "short",
//   entryPrice: 0,
//   amount: 0,
//   costBasis: 0,
//   entryDate: "",
//   stopLoss: 0,
//   targets: [
//     { price: 47500, label: "H&S Neckline" },
//     { price: 46550, label: "Bear Flag Target" },
//   ],
//   exchange: "eToro",
//   status: "closed",
// },
