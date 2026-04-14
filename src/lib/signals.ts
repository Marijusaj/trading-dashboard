// Signal definitions for CryptoSniper trade setups
// These drive the dashboard signal indicator

export interface ScalingTranche {
  id: number;
  label: string;
  trigger: string;
  triggerPrice: number | null; // null = manual condition
  size: number; // USD
  status: "done" | "ready" | "waiting";
}

export interface TradeSignal {
  asset: string;
  pair: string;
  direction: "long" | "short";
  breakoutLevel: number;
  confirmLevel: number; // price above this = confirmed breakout
  stopLevel: number;
  invalidateLevel: number; // below this = thesis dead
  targets: { price: number; label: string }[];
  scalingPlan: ScalingTranche[];
  source: string; // who called it
  lastUpdated: string;
  notes: string;
}

export const TRX_SIGNAL: TradeSignal = {
  asset: "TRX",
  pair: "TRX/USDC",
  direction: "long",
  breakoutLevel: 0.32,
  confirmLevel: 0.34,
  stopLevel: 0.3066,
  invalidateLevel: 0.29,
  targets: [
    { price: 0.38, label: "W Bottom" },
    { price: 0.50, label: "Macro" },
    { price: 4.72, label: "Monthly HVF" },
  ],
  scalingPlan: [
    {
      id: 1,
      label: "Seat at the table",
      trigger: "Initial entry",
      triggerPrice: null,
      size: 110,
      status: "done",
    },
    {
      id: 2,
      label: "Breakout confirmed",
      trigger: "Daily close above $0.32",
      triggerPrice: 0.32,
      size: 1000,
      status: "waiting",
    },
    {
      id: 3,
      label: "Support holds",
      trigger: "$0.32 holds as support 3 days",
      triggerPrice: 0.32,
      size: 1500,
      status: "waiting",
    },
    {
      id: 4,
      label: "Full conviction",
      trigger: "Break above $0.34",
      triggerPrice: 0.34,
      size: 1500,
      status: "waiting",
    },
  ],
  source: "CryptoSniper (Francis Hunt) — April 13, 2026",
  lastUpdated: "2026-04-13",
  notes: "W-bottom at $0.32. Bull pennant squeezing on weekly. May divergence expected — TRX up while BTC/SOL/XRP sell off. 53% of USDT on Tron network.",
};

export type SignalStatus = "setup" | "testing" | "breakout" | "confirmed" | "invalidated";

/**
 * Get signal status from current price + last daily close.
 * - "setup": price below breakout, waiting
 * - "testing": price INTRADAY above breakout, but no daily close confirmation
 * - "breakout": last daily candle CLOSED above breakout level
 * - "confirmed": price above confirm level ($0.34)
 * - "invalidated": price below invalidation
 */
export function getSignalStatus(
  price: number,
  signal: TradeSignal,
  lastDailyClose?: number,
): SignalStatus {
  if (price <= signal.invalidateLevel) return "invalidated";
  if (price >= signal.confirmLevel) return "confirmed";

  // If we have a daily close, use it to distinguish testing vs breakout
  if (lastDailyClose !== undefined) {
    if (lastDailyClose >= signal.breakoutLevel) return "breakout";
    if (price >= signal.breakoutLevel) return "testing";
    return "setup";
  }

  // Without daily close data, use price but flag as testing
  if (price >= signal.breakoutLevel) return "testing";
  return "setup";
}

export const SIGNAL_CONFIG: Record<
  SignalStatus,
  { label: string; color: string; bgColor: string; borderColor: string; pulseColor: string; description: string }
> = {
  setup: {
    label: "SETUP",
    color: "text-amber-400",
    bgColor: "bg-amber-950/30",
    borderColor: "border-amber-700/60",
    pulseColor: "bg-amber-500",
    description: "Squeeze forming. Awaiting breakout above $0.32",
  },
  testing: {
    label: "TESTING $0.32",
    color: "text-yellow-400",
    bgColor: "bg-yellow-950/30",
    borderColor: "border-yellow-600/60",
    pulseColor: "bg-yellow-500",
    description: "Price above $0.32 INTRADAY. Need daily close above $0.32 to confirm.",
  },
  breakout: {
    label: "SIGNAL ON",
    color: "text-green-400",
    bgColor: "bg-green-950/40",
    borderColor: "border-green-500/60",
    pulseColor: "bg-green-500",
    description: "Daily close above $0.32 CONFIRMED. Add size per scaling plan.",
  },
  confirmed: {
    label: "CONFIRMED",
    color: "text-green-300",
    bgColor: "bg-green-950/50",
    borderColor: "border-green-400/70",
    pulseColor: "bg-green-400",
    description: "Breakout confirmed above $0.34. W-bottom active. Full conviction.",
  },
  invalidated: {
    label: "INVALIDATED",
    color: "text-red-400",
    bgColor: "bg-red-950/40",
    borderColor: "border-red-600/60",
    pulseColor: "bg-red-500",
    description: "Below stop. Thesis broken. Exit position.",
  },
};
