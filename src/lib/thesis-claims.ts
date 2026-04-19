// Each claim is auto-evaluated daily against current market data
// Source: CryptoSniper (Francis Hunt) April 13, 2026 video
// + independent verification

export type ClaimStatus = "holding" | "weakened" | "broken" | "too_early" | "fantasy";

export interface ThesisClaim {
  id: string;
  category: "TRX" | "BTC" | "Macro";
  claim: string;
  source: string;
  // Function takes current market data and returns status + reasoning
  evaluate: (data: MarketData) => { status: ClaimStatus; reasoning: string };
}

export interface MarketData {
  btcPrice: number;
  trxPrice: number;
  solPrice: number;
  ethPrice: number;
  btcDominance: number; // %
  usdtDominance: number; // %
  trxMarketCap: number;
  solMarketCap: number;
  // Optional: 7-day change for trend detection
  btc7dChange?: number;
  trx7dChange?: number;
  sol7dChange?: number;
  // Today's date for time-based eval
  evalDate: Date;
}

export const THESIS_CLAIMS: ThesisClaim[] = [
  // ───── TRX claims ─────
  {
    id: "trx_breakout_033",
    category: "TRX",
    claim: "TRX W-bottom breakout above $0.33",
    source: "Francis + verified",
    evaluate: ({ trxPrice }) => {
      if (trxPrice >= 0.34) return { status: "holding", reasoning: `TRX at $${trxPrice.toFixed(4)} — broke above $0.33 confirmation level` };
      if (trxPrice >= 0.33) return { status: "holding", reasoning: `TRX at $${trxPrice.toFixed(4)} — at/above breakout level, awaiting confirmation` };
      if (trxPrice >= 0.30) return { status: "too_early", reasoning: `TRX at $${trxPrice.toFixed(4)} — still consolidating below $0.33` };
      if (trxPrice < 0.285) return { status: "broken", reasoning: `TRX at $${trxPrice.toFixed(4)} — broke below $0.285 invalidation` };
      return { status: "weakened", reasoning: `TRX at $${trxPrice.toFixed(4)} — below stop, thesis at risk` };
    },
  },
  {
    id: "trx_target_035",
    category: "TRX",
    claim: "TRX reaches $0.35 (verified target)",
    source: "Independent verification",
    evaluate: ({ trxPrice }) => {
      if (trxPrice >= 0.35) return { status: "holding", reasoning: `Target hit! TRX at $${trxPrice.toFixed(4)}` };
      if (trxPrice >= 0.32) return { status: "too_early", reasoning: `TRX at $${trxPrice.toFixed(4)} — within striking distance` };
      return { status: "weakened", reasoning: `TRX at $${trxPrice.toFixed(4)} — far from target` };
    },
  },
  {
    id: "trx_flips_sol",
    category: "TRX",
    claim: "TRX market cap flips Solana",
    source: "Francis (we said unlikely)",
    evaluate: ({ trxMarketCap, solMarketCap }) => {
      const ratio = trxMarketCap / solMarketCap;
      if (ratio >= 1) return { status: "holding", reasoning: `FLIP! TRX $${(trxMarketCap / 1e9).toFixed(1)}B > SOL $${(solMarketCap / 1e9).toFixed(1)}B` };
      if (ratio >= 0.85) return { status: "holding", reasoning: `Closing gap: TRX/SOL ratio ${(ratio * 100).toFixed(1)}%` };
      if (ratio >= 0.65) return { status: "weakened", reasoning: `Gap widening: TRX/SOL ratio ${(ratio * 100).toFixed(1)}%` };
      return { status: "broken", reasoning: `TRX/SOL ratio only ${(ratio * 100).toFixed(1)}% — flip not happening` };
    },
  },
  {
    id: "trx_long_472",
    category: "TRX",
    claim: "TRX reaches $4.72 long-term",
    source: "Francis (no independent support)",
    evaluate: ({ trxPrice }) => {
      if (trxPrice >= 4.72) return { status: "holding", reasoning: "Hit. Insanity confirmed." };
      if (trxPrice >= 1.0) return { status: "too_early", reasoning: `TRX at $${trxPrice.toFixed(2)} — in the running` };
      return { status: "fantasy", reasoning: `TRX at $${trxPrice.toFixed(4)} — would need ~14x. No independent support.` };
    },
  },

  // ───── BTC claims ─────
  {
    id: "btc_bear_flag",
    category: "BTC",
    claim: "BTC bear flag intact, breaks down to $47.5K-$36K",
    source: "Francis",
    evaluate: ({ btcPrice }) => {
      if (btcPrice < 47500) return { status: "holding", reasoning: `BTC at $${btcPrice.toLocaleString()} — broke flag, hit first target` };
      if (btcPrice < 65000) return { status: "holding", reasoning: `BTC at $${btcPrice.toLocaleString()} — broke below $65K demand zone` };
      if (btcPrice < 76000) return { status: "holding", reasoning: `BTC at $${btcPrice.toLocaleString()} — still in flag, $76K rejection holding` };
      if (btcPrice < 85000) return { status: "weakened", reasoning: `BTC at $${btcPrice.toLocaleString()} — broke flag UPSIDE` };
      return { status: "broken", reasoning: `BTC at $${btcPrice.toLocaleString()} — flag invalidated, new highs in play` };
    },
  },
  {
    id: "btc_dominance",
    category: "BTC",
    claim: "BTC dominance breaks higher from 58-60%",
    source: "Francis",
    evaluate: ({ btcDominance }) => {
      if (btcDominance >= 60) return { status: "holding", reasoning: `BTC.D at ${btcDominance.toFixed(1)}% — above range, breaking higher` };
      if (btcDominance >= 58) return { status: "too_early", reasoning: `BTC.D at ${btcDominance.toFixed(1)}% — in Francis's range` };
      return { status: "broken", reasoning: `BTC.D at ${btcDominance.toFixed(1)}% — BELOW the 58% floor he cited` };
    },
  },

  // ───── Macro claims ─────
  {
    id: "usdt_dominance",
    category: "Macro",
    claim: "USDT dominance pushes to 10%+",
    source: "Francis",
    evaluate: ({ usdtDominance }) => {
      if (usdtDominance >= 10) return { status: "holding", reasoning: `USDT.D at ${usdtDominance.toFixed(2)}% — TARGET HIT` };
      if (usdtDominance >= 9) return { status: "too_early", reasoning: `USDT.D at ${usdtDominance.toFixed(2)}% — testing 9% resistance` };
      if (usdtDominance >= 8) return { status: "weakened", reasoning: `USDT.D at ${usdtDominance.toFixed(2)}% — far from 10% target` };
      return { status: "broken", reasoning: `USDT.D at ${usdtDominance.toFixed(2)}% — heading wrong direction` };
    },
  },
  {
    id: "may_selloff",
    category: "Macro",
    claim: "May 2026 broad crypto selloff",
    source: "Francis",
    evaluate: ({ evalDate, btc7dChange, trx7dChange }) => {
      const month = evalDate.getMonth(); // 0-11
      const day = evalDate.getDate();
      // Before May 1
      if (month < 4) return { status: "too_early", reasoning: "May hasn't started yet" };
      // May
      if (month === 4) {
        const drop = (btc7dChange ?? 0) < -10;
        if (drop) return { status: "holding", reasoning: `BTC down ${btc7dChange?.toFixed(1)}% in 7d — selloff active` };
        if (day < 15) return { status: "too_early", reasoning: "Early May, watching for selloff" };
        return { status: "weakened", reasoning: `Mid-May, BTC ${btc7dChange?.toFixed(1)}% — no major selloff yet` };
      }
      // After May
      if (month > 4) {
        const trxRecovered = (trx7dChange ?? 0) > 0;
        if (trxRecovered) return { status: "broken", reasoning: "May ended without major selloff" };
        return { status: "weakened", reasoning: "May passed without clear selloff" };
      }
      return { status: "too_early", reasoning: "Awaiting May data" };
    },
  },
];

export const STATUS_CONFIG: Record<ClaimStatus, { label: string; color: string; bg: string; emoji: string }> = {
  holding: { label: "HOLDING", color: "text-green-400", bg: "bg-green-950/30 border-green-900/40", emoji: "🟢" },
  weakened: { label: "WEAKENED", color: "text-amber-400", bg: "bg-amber-950/30 border-amber-700/40", emoji: "🟡" },
  broken: { label: "BROKEN", color: "text-red-400", bg: "bg-red-950/30 border-red-900/40", emoji: "🔴" },
  too_early: { label: "TOO EARLY", color: "text-blue-400", bg: "bg-blue-950/30 border-blue-900/40", emoji: "⏳" },
  fantasy: { label: "FANTASY", color: "text-purple-400", bg: "bg-purple-950/30 border-purple-900/40", emoji: "🦄" },
};
