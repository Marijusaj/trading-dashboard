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
    upperTrendlineSlope: number;
    lowerTrendlineSlope: number;
    funnelConvergence: number;  // 0..1, 1 = perfect convergence
    ema20: number;
    ema50: number;
    ema200: number;
    recentLow: number;
    recentHigh: number;
    distanceToSupport: number;  // %
    distanceToResistance: number; // %
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
  // Look at recent 30 bars. Take rolling-window highs and lows.
  const recent = candles.slice(-30);
  const recentHighs = recent.slice(0, 15).reduce((m, c) => Math.max(m, c.high), 0);
  const tailHighs = recent.slice(-15).reduce((m, c) => Math.max(m, c.high), 0);
  const recentLows = recent.slice(0, 15).reduce((m, c) => Math.min(m, c.low), Infinity);
  const tailLows = recent.slice(-15).reduce((m, c) => Math.min(m, c.low), Infinity);
  // Upper line: from recentHighs (early) to tailHighs (late) — should slope DOWN
  const upperTrendlineSlope = (tailHighs - recentHighs) / recentHighs / 15;
  // Lower line: should slope UP
  const lowerTrendlineSlope = (tailLows - recentLows) / recentLows / 15;
  // Convergence: upper slope negative AND lower slope positive
  const isConverging = upperTrendlineSlope < 0 && lowerTrendlineSlope > 0;
  const convergenceMagnitude = Math.abs(upperTrendlineSlope) + Math.abs(lowerTrendlineSlope);
  const funnelConvergence = isConverging ? Math.min(1, convergenceMagnitude * 100) : 0;
  const funnelStructure = funnelConvergence * 25;

  // ── Volume contraction ─────────────────────────────────────────
  let volumeContraction = 0;
  if (volumes.some((v) => v > 0)) {
    const recentVol = volumes.slice(-10).reduce((s, v) => s + v, 0) / 10;
    const historicVol = volumes.slice(-40, -10).reduce((s, v) => s + v, 0) / 30;
    if (historicVol > 0) {
      const ratio = recentVol / historicVol;
      // Score: 15 if recent < 60% of historic; 0 if >= 100%
      volumeContraction = Math.max(0, Math.min(15, (1 - ratio) * 37.5));
    }
  } else {
    // No volume data — give it a neutral 7.5
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
    signals.push(`Funnel: highs descending ${(upperTrendlineSlope * 100).toFixed(2)}%/bar, lows ascending ${(lowerTrendlineSlope * 100).toFixed(2)}%/bar`);
  }
  if (volumeContraction > 8 && volumes.some((v) => v > 0)) {
    signals.push(`Volume contracted into squeeze`);
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
      upperTrendlineSlope: Number(upperTrendlineSlope.toFixed(6)),
      lowerTrendlineSlope: Number(lowerTrendlineSlope.toFixed(6)),
      funnelConvergence: Number(funnelConvergence.toFixed(3)),
      ema20: Number(ema20.toFixed(6)),
      ema50: Number(ema50.toFixed(6)),
      ema200: Number(ema200.toFixed(6)),
      recentLow: Number(recentLow.toFixed(6)),
      recentHigh: Number(recentHigh.toFixed(6)),
      distanceToSupport: Number(distanceToSupport.toFixed(2)),
      distanceToResistance: Number(distanceToResistance.toFixed(2)),
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
