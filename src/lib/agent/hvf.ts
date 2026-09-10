// HVF (Hunt Volatility Funnel) programmatic analyzer.
//
// Encodes Francis Hunt's HVF methodology as deterministic checks
// against an OHLC series. The agent uses these scores to filter
// the universe before asking Claude to make a final call.
//
// HVF criteria (paraphrased from Francis's videos / persona.md):
//   1. Range compression  — recent ATR shrinking vs longer-term ATR.
//   2. Funnel structure   — converging highs and lows over the lookback.
//   3. Volume contraction — declining volume into the squeeze.
//   4. Trend alignment    — direction of broader (longer EMA) move.
//   5. Distance to S/R    — proximity to nearest significant pivot.
//   6. Recency            — pattern must be playing out NOW, not 30d ago.
//
// Output is a 0-100 score plus a structured breakdown so the agent
// can quote which leg of HVF triggered.

export interface OHLC {
  time: number;        // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface HVFAnalysis {
  score: number;                // 0-100, > 60 = candidate, > 75 = strong
  direction: "long" | "short" | "neutral";
  components: {
    rangeCompression: number;   // 0-25
    funnelStructure: number;    // 0-25
    volumeContraction: number;  // 0-15
    trendAlignment: number;     // 0-20
    levelProximity: number;     // 0-15
  };
  metrics: {
    currentATR: number;
    historicATR: number;
    compressionRatio: number;   // current / historic, < 1 = compressed
    /** Fraction of the early band the highs stepped down by. */
    upperPull: number;
    /** Fraction of the early band the lows stepped up by. */
    lowerPull: number;
    /** upperPull + lowerPull — how much of its own band the asset closed. */
    bandContraction: number;
    funnelConvergence: number;  // 0..1, 1 = perfect convergence
    ema20: number;
    ema50: number;
    ema200: number;
    recentLow: number;
    recentHigh: number;
    distanceToSupport: number;  // %
    distanceToResistance: number; // %
    /** False when the candle series carried no usable volume, in which
     *  case volumeContraction is the neutral 7.5 rather than a real
     *  measurement. Surfaced so a low score can be told apart from a
     *  blind one. */
    volumeDataAvailable: boolean;
  };
  signals: string[];            // human-readable narrative bullets
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function ema(values: number[], period: number): number {
  if (values.length === 0) return NaN;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function atr(candles: OHLC[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trs.push(tr);
  }
  const window = trs.slice(-period);
  return window.reduce((s, v) => s + v, 0) / window.length;
}

/** Linear regression slope of a series. Slope normalized to % per bar. */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  if (den === 0) return 0;
  return num / den / yMean; // normalized slope
}

/** Find the most recent significant high/low pivots. */
function pivots(candles: OHLC[], lookback = 5): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    if (window.every((w) => c.high >= w.high)) highs.push(c.high);
    if (window.every((w) => c.low <= w.low)) lows.push(c.low);
  }
  return { highs, lows };
}

// ────────────────────────────────────────────────────────────────────
// Main analysis
// ────────────────────────────────────────────────────────────────────

export function analyzeHVF(candles: OHLC[]): HVFAnalysis | null {
  if (candles.length < 60) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume ?? 0);

  // ── Range compression (ATR ratio) ─────────────────────────────
  const currentATR = atr(candles.slice(-14), 14);
  const historicATR = atr(candles.slice(-60, -14), 46);
  const compressionRatio = historicATR > 0 ? currentATR / historicATR : 1;
  // Score: 25 if currentATR < 50% of historic; 0 if currentATR >= historic
  const rangeCompression = Math.max(0, Math.min(25, (1 - compressionRatio) * 50));

  // ── Funnel structure (converging trendlines) ──────────────────
  // A funnel is a SHAPE: highs stepping down while lows step up. Magnitude
  // of compression is rangeCompression's job (ATR ratio); this leg's only
  // distinctive contribution is whether both boundaries actually converge.
  //
  // Measured over three consecutive 10-bar sub-windows rather than two
  // 15-bar halves. Two halves compare one min/max block against another, so
  // a single outlier bar early in the window sets a huge "before" band and
  // any quieter second half reads as a squeeze — which is how XRP could
  // score a full 25/25 for "converging structure" on the same candles where
  // its ATR was 13% ABOVE its own 60-bar baseline. Requiring the highs to be
  // non-increasing and the lows non-decreasing across all three sub-windows
  // asks for a wedge that actually holds, which one spike cannot fake.
  const recent = candles.slice(-30);
  const win = (from: number, to: number) => {
    const w = recent.slice(from, to);
    return {
      high: w.reduce((m, c) => Math.max(m, c.high), 0),
      low: w.reduce((m, c) => Math.min(m, c.low), Infinity),
    };
  };
  const w1 = win(0, 10);
  const w2 = win(10, 20);
  const w3 = win(20, 30);
  const earlyBand = w1.high - w1.low;
  const lateBand = w3.high - w3.low;
  // Fractions of the asset's OWN starting band, so the leg is scale-free:
  // an asset already coiled tight is judged on further tightening rather
  // than on having a wide band left to give back.
  const upperPull = earlyBand > 0 ? (w1.high - w3.high) / earlyBand : 0;
  const lowerPull = earlyBand > 0 ? (w3.low - w1.low) / earlyBand : 0;
  const bandContraction = earlyBand > 0 ? (earlyBand - lateBand) / earlyBand : 0;
  // Monotone on both edges — a wedge, not a drift and not one wick.
  const isConverging =
    w1.high >= w2.high && w2.high >= w3.high &&
    w1.low <= w2.low && w2.low <= w3.low &&
    upperPull > 0 && lowerPull > 0;
  // Full marks at a band halved across the window; linear below.
  const funnelConvergence = isConverging ? Math.max(0, Math.min(1, bandContraction / 0.5)) : 0;
  const funnelStructure = funnelConvergence * 25;

  // ── Volume contraction ─────────────────────────────────────────
  // Scored ONLY when both comparison windows are fully populated. A
  // partially-populated series (eToro returns null volume for some
  // instruments/timeframes) is the dangerous case: if the recent window
  // is missing but the historic one isn't, ratio → 0 and this leg reads
  // as "volume collapsed" = full 15/15, manufacturing a squeeze signal
  // out of a data gap. Neutral 7.5 is the honest answer there.
  const recentVols = volumes.slice(-10);
  const historicVols = volumes.slice(-40, -10);
  const volumeDataAvailable =
    recentVols.length === 10 &&
    historicVols.length === 30 &&
    recentVols.every((v) => v > 0) &&
    historicVols.every((v) => v > 0);

  let volumeContraction: number;
  if (volumeDataAvailable) {
    const recentVol = recentVols.reduce((s, v) => s + v, 0) / 10;
    const historicVol = historicVols.reduce((s, v) => s + v, 0) / 30;
    const ratio = recentVol / historicVol;
    // Score: 15 if recent < 60% of historic; 0 if >= 100%
    volumeContraction = Math.max(0, Math.min(15, (1 - ratio) * 37.5));
  } else {
    // No usable volume data — neutral 7.5, neither reward nor penalty.
    volumeContraction = 7.5;
  }

  // ── Trend alignment ────────────────────────────────────────────
  const ema20 = ema(closes.slice(-40), 20);
  const ema50 = ema(closes.slice(-100), 50);
  const ema200 = ema(closes, 200);
  const lastClose = closes[closes.length - 1];
  // Bullish stack: price > ema20 > ema50 > ema200
  const bullStack = lastClose > ema20 && ema20 > ema50 && ema50 > ema200;
  const bearStack = lastClose < ema20 && ema20 < ema50 && ema50 < ema200;
  let trendAlignment = 0;
  let direction: "long" | "short" | "neutral" = "neutral";
  if (bullStack) {
    trendAlignment = 20;
    direction = "long";
  } else if (bearStack) {
    trendAlignment = 20;
    direction = "short";
  } else if (lastClose > ema50 && ema20 > ema50) {
    trendAlignment = 12;
    direction = "long";
  } else if (lastClose < ema50 && ema20 < ema50) {
    trendAlignment = 12;
    direction = "short";
  } else {
    trendAlignment = 5;
  }

  // ── Level proximity (distance to recent S/R) ──────────────────
  const piv = pivots(candles, 5);
  const recentLow = piv.lows.length > 0 ? piv.lows[piv.lows.length - 1] : Math.min(...lows.slice(-30));
  const recentHigh = piv.highs.length > 0 ? piv.highs[piv.highs.length - 1] : Math.max(...highs.slice(-30));
  const distanceToSupport = ((lastClose - recentLow) / lastClose) * 100;
  const distanceToResistance = ((recentHigh - lastClose) / lastClose) * 100;
  // Score: max when within 2% of either level
  const minDistance = Math.min(Math.abs(distanceToSupport), Math.abs(distanceToResistance));
  const levelProximity = Math.max(0, Math.min(15, 15 - minDistance * 3));

  // ── Compose ────────────────────────────────────────────────────
  const score = rangeCompression + funnelStructure + volumeContraction + trendAlignment + levelProximity;

  const signals: string[] = [];
  if (compressionRatio < 0.7) {
    signals.push(`ATR compressed to ${(compressionRatio * 100).toFixed(0)}% of 60-bar baseline`);
  }
  if (isConverging) {
    signals.push(`Funnel: band closed ${(bandContraction * 100).toFixed(0)}% of its own width (highs down ${(upperPull * 100).toFixed(0)}%, lows up ${(lowerPull * 100).toFixed(0)}%)`);
  }
  if (volumeDataAvailable && volumeContraction > 8) {
    signals.push(`Volume contracted into squeeze`);
  }
  if (!volumeDataAvailable) {
    signals.push(`No volume data for this series — volume leg scored neutral (7.5/15)`);
  }
  if (bullStack) signals.push(`Bullish EMA stack (price > 20 > 50 > 200)`);
  if (bearStack) signals.push(`Bearish EMA stack (price < 20 < 50 < 200)`);
  if (Math.abs(distanceToSupport) < 2) signals.push(`Within ${distanceToSupport.toFixed(2)}% of recent support ${recentLow.toFixed(4)}`);
  if (Math.abs(distanceToResistance) < 2) signals.push(`Within ${distanceToResistance.toFixed(2)}% of recent resistance ${recentHigh.toFixed(4)}`);

  return {
    score,
    direction,
    components: {
      rangeCompression: Number(rangeCompression.toFixed(1)),
      funnelStructure: Number(funnelStructure.toFixed(1)),
      volumeContraction: Number(volumeContraction.toFixed(1)),
      trendAlignment,
      levelProximity: Number(levelProximity.toFixed(1)),
    },
    metrics: {
      currentATR: Number(currentATR.toFixed(6)),
      historicATR: Number(historicATR.toFixed(6)),
      compressionRatio: Number(compressionRatio.toFixed(3)),
      upperPull: Number(upperPull.toFixed(4)),
      lowerPull: Number(lowerPull.toFixed(4)),
      bandContraction: Number(bandContraction.toFixed(4)),
      funnelConvergence: Number(funnelConvergence.toFixed(3)),
      ema20: Number(ema20.toFixed(6)),
      ema50: Number(ema50.toFixed(6)),
      ema200: Number(ema200.toFixed(6)),
      recentLow: Number(recentLow.toFixed(6)),
      recentHigh: Number(recentHigh.toFixed(6)),
      distanceToSupport: Number(distanceToSupport.toFixed(2)),
      distanceToResistance: Number(distanceToResistance.toFixed(2)),
      volumeDataAvailable,
    },
    signals,
  };
}

// ────────────────────────────────────────────────────────────────────
// Stop / target sizing helpers
// ────────────────────────────────────────────────────────────────────

export interface RiskParams {
  entryPrice: number;
  direction: "long" | "short";
  atr: number;
  recentLow: number;
  recentHigh: number;
  /** Minimum reward:risk to require. Defaults to 1.5. */
  minRR?: number;
  /** Multiplier on ATR for stop placement. Defaults to 1.5. */
  atrStopMultiplier?: number;
  /** Broker minimum stop distance as % of entry. If set, SL is padded
   *  outward to at least this distance (prevents guardrail/broker-widening
   *  from killing setups). E.g. 5.5 for crypto shorts on eToro. */
  minStopPct?: number;
}

export interface RiskPlan {
  stopLoss: number;
  takeProfit: number;
  rewardRiskRatio: number;
  stopDistancePct: number;
  targetDistancePct: number;
}

export function planRisk(p: RiskParams): RiskPlan {
  const { entryPrice, direction, atr: atrVal, recentLow, recentHigh } = p;
  const minRR = p.minRR ?? 1.5;
  const atrMult = p.atrStopMultiplier ?? 1.5;
  // Broker minimum stop distance as % of entry. If provided, SL will be
  // padded out to at least this distance — preventing the guardrail
  // (and eToro's silent widening) from killing otherwise-good HVF setups.
  const minStopPct = p.minStopPct;

  let stopLoss: number;
  let takeProfit: number;

  if (direction === "long") {
    // Stop is the tighter of: ATR-based, recent pivot low - small buffer
    const atrStop = entryPrice - atrVal * atrMult;
    const pivotStop = recentLow * 0.995;
    stopLoss = Math.max(atrStop, pivotStop); // tighter (closer to entry) is max
    // Pad outward to broker minimum if specified
    if (minStopPct !== undefined) {
      const brokerMinSl = entryPrice * (1 - minStopPct / 100);
      stopLoss = Math.min(stopLoss, brokerMinSl);  // wider (further from entry) is min
    }
    const risk = entryPrice - stopLoss;
    takeProfit = Math.max(recentHigh * 1.005, entryPrice + risk * minRR);
  } else {
    const atrStop = entryPrice + atrVal * atrMult;
    const pivotStop = recentHigh * 1.005;
    stopLoss = Math.min(atrStop, pivotStop);
    // Pad outward to broker minimum if specified
    if (minStopPct !== undefined) {
      const brokerMinSl = entryPrice * (1 + minStopPct / 100);
      stopLoss = Math.max(stopLoss, brokerMinSl);  // wider (further from entry) is max for shorts
    }
    const risk = stopLoss - entryPrice;
    takeProfit = Math.min(recentLow * 0.995, entryPrice - risk * minRR);
  }

  const stopDistance = Math.abs(entryPrice - stopLoss);
  const targetDistance = Math.abs(takeProfit - entryPrice);
  const rewardRiskRatio = stopDistance > 0 ? targetDistance / stopDistance : 0;

  return {
    stopLoss: Number(stopLoss.toFixed(6)),
    takeProfit: Number(takeProfit.toFixed(6)),
    rewardRiskRatio: Number(rewardRiskRatio.toFixed(2)),
    stopDistancePct: Number(((stopDistance / entryPrice) * 100).toFixed(2)),
    targetDistancePct: Number(((targetDistance / entryPrice) * 100).toFixed(2)),
  };
}
