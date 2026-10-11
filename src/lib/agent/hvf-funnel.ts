// Hunt Volatility Funnel — geometric detector.
//
// Finds Francis Hunt's actual HVF in raw OHLCV numbers: a prior trend that
// exhausts at 1H, then three alternating swings that each get smaller
// (1H/1L, 2H/2L, 3H/3L). Levels come from the geometry, not from indicators:
//
//   entry   = 3H (buy-stop)            target   = midway + |1H − 1L|
//   stop    = 3L                       interim2 = midway + |2H − 2L|
//   midway  = (3H + 3L) / 2
//
// The inverted (bearish) HVF is the mirror image, detected by running the
// same code on the price series multiplied by −1.
//
// Rule sources and confidence: docs/hvf-spec.md. Everything this file
// decides that Hunt has NOT specified publicly is listed in ASSUMPTIONS and
// echoed in every result, so the agent (and the reviewer) can see which
// parts are ours.
//
// Pure module: no I/O, no imports. OHLC in, numbers out.

export interface Candle {
  time: number;        // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type FunnelStatus =
  | "forming"       // 3L printed, price still inside the funnel, trigger not hit
  | "triggered"     // price crossed the entry level, neither stop nor target hit yet
  | "target_hit"
  | "stopped"
  | "invalidated"   // closed beyond the stop side before ever triggering
  | "stale";        // still forming but far too long after 3L

export interface FunnelPoint {
  index: number;
  time: number;
  price: number;
}

export interface VolumeZone {
  low: number;
  high: number;
  /** Share of all profiled volume inside this zone, 0..1 */
  share: number;
}

export interface VolumeProfile {
  from: number;               // unix seconds of first candle profiled
  poc: number;                // price of the highest-volume bin
  valueAreaLow: number;       // 70% value area
  valueAreaHigh: number;
  /** High-volume nodes = Hunt's key levels of significance (KLOS) */
  hvnZones: VolumeZone[];
  /** Low-volume gaps = Hunt's "voids and vacuums" */
  voidZones: VolumeZone[];
}

export interface HvfFunnel {
  direction: "long" | "short";
  /** Pivot strength (bars each side) at which this funnel was found */
  pivotStrength: number;
  points: {
    h1: FunnelPoint; l1: FunnelPoint;
    h2: FunnelPoint; l2: FunnelPoint;
    h3: FunnelPoint; l3: FunnelPoint;
  };
  amplitudes: { amp1: number; amp2: number; amp3: number };
  levels: {
    entry: number;
    stop: number;
    midway: number;
    target: number;
    /** Second interim (AMP2 from midway). Null when it sits on or before entry. */
    interim2: number | null;
  };
  /** (target − entry) / (entry − stop), measured from the entry level */
  rewardRisk: number;
  stopDistancePct: number;
  targetDistancePct: number;
  priorTrend: { fromPrice: number; size: number; bars: number };
  /** Bars from 1H to 3L */
  funnelBars: number;
  /** Bars since 3L (as of the last candle) */
  barsSince3: number;
  status: FunnelStatus;
  trigger: null | {
    index: number;
    time: number;
    /** Trigger-bar volume ÷ 20-bar average before it. Null if no volume data. */
    volumeRatio: number | null;
    /** Where the trigger bar closed within its range in the breakout direction, 0..1 (1 = at the extreme) */
    closeLocation: number;
    /** Hunt: real breaks are expansive, close near the extreme, on above-average volume */
    looksReal: boolean | null;
  };
  /** Second interim reached after the trigger. Hunt: don't charge in after an interim — a pullback usually follows. */
  interim2Hit: boolean;
  /** Distance from the last close to the entry level, % of entry (positive = not yet reached) */
  distanceToEntryPct: number;
  /** Nested "squeeze within the squeeze" (Hunt's primer). Its break IS the break of this pattern:
   *  earlier entry, tighter stop, this funnel's target. Null when none found. */
  primer: null | {
    entry: number;
    stop: number;
    status: FunnelStatus;
    /** Breakout quality of the primer's trigger bar (null = not triggered or no volume data) */
    looksReal: boolean | null;
    /** Reward:risk using the primer's entry/stop against THIS funnel's target */
    rewardRisk: number;
    points: HvfFunnel["points"];
  };
  volume: null | {
    triggerOnKlos: boolean;
    heavyZonesToTarget: VolumeZone[];
    /** Share of the entry→target path that runs through voids, 0..1 */
    voidPathShare: number;
  };
  /** 0-100 quality score for ranking. Our weighting — not Hunt's. See scoreFunnel(). */
  score: number;
  notes: string[];
}

export interface HvfFunnelAnalysis {
  /** Best actionable funnel (forming / freshly triggered), else most recent valid one, else null */
  best: HvfFunnel | null;
  /** Up to 5 most relevant funnels, best first */
  funnels: HvfFunnel[];
  profile: VolumeProfile | null;
  /** Targets of older, completed funnels. Hunt: legacy targets keep acting as key levels later. */
  legacyTargets: { price: number; direction: "long" | "short"; status: FunnelStatus; time: number }[];
  assumptions: string[];
}

/** Choices this detector makes that Hunt has not published. Revisit as the spec firms up. */
export const ASSUMPTIONS: string[] = [
  "Swing points = fractal pivots at strengths 2/3/5/8 bars; Hunt picks points by eye",
  "Flat edge allowed: a high may exceed the previous high (or a low undercut the previous low) by up to 25% of AMP3",
  "Each swing must be strictly smaller than the previous: AMP1 > AMP2 > AMP3, and AMP3 ≤ 75% of AMP1",
  "Prior trend: the move into 1H must be at least AMP1 in size, measured over max(10, funnel length) bars before 1H",
  "Entry and stop sit exactly on 3H and 3L with no buffer",
  "Invalidated if a candle CLOSES beyond 3L (3H for inverted) before the trigger",
  "Stale if still forming more than 2× the funnel's own length after 3L",
  "First interim not computed — formula unknown",
  "Primer = a same-direction funnel whose 1st swing sits inside the parent's 2nd-swing band, starting after the parent's 2nd swing",
];

const PIVOT_STRENGTHS = [2, 3, 5, 8];

/** Round to 6 significant digits — enough for sats-priced pairs, readable for BTC. */
const sig = (x: number) => Number(x.toPrecision(6));
const FLAT_TOLERANCE_OF_AMP3 = 0.25;
const MAX_AMP3_OF_AMP1 = 0.75;
const STALE_MULTIPLE = 2;
const VOLUME_AVG_BARS = 20;

// ────────────────────────────────────────────────────────────────────
// Swings
// ────────────────────────────────────────────────────────────────────

interface Pivot { index: number; price: number; kind: "H" | "L" }

/** Fractal pivots at the given strength, compressed to a strictly alternating H/L sequence. */
export function findSwings(candles: Candle[], strength: number): Pivot[] {
  const raw: Pivot[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) raw.push({ index: i, price: candles[i].high, kind: "H" });
    if (isLow) raw.push({ index: i, price: candles[i].low, kind: "L" });
  }
  // Alternate: of consecutive same-kind pivots keep the most extreme.
  const out: Pivot[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (!last || last.kind !== p.kind) {
      out.push(p);
    } else if ((p.kind === "H" && p.price > last.price) || (p.kind === "L" && p.price < last.price)) {
      out[out.length - 1] = p;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Volume profile (volume-by-price)
// ────────────────────────────────────────────────────────────────────

const PROFILE_BINS = 60;
const VALUE_AREA = 0.7;

/** Volume-by-price over the whole series on log-spaced bins. Null when the series carries no volume. */
export function buildVolumeProfile(candles: Candle[]): VolumeProfile | null {
  const withVol = candles.filter((c) => (c.volume ?? 0) > 0 && c.low > 0);
  if (withVol.length < candles.length * 0.8 || withVol.length < 30) return null;

  const lo = Math.min(...withVol.map((c) => c.low));
  const hi = Math.max(...withVol.map((c) => c.high));
  if (!(hi > lo)) return null;
  const logLo = Math.log(lo);
  const step = (Math.log(hi) - logLo) / PROFILE_BINS;
  const edge = (i: number) => Math.exp(logLo + step * i);
  const binOf = (price: number) => Math.min(PROFILE_BINS - 1, Math.max(0, Math.floor((Math.log(price) - logLo) / step)));

  const bins = new Array<number>(PROFILE_BINS).fill(0);
  for (const c of withVol) {
    const a = binOf(c.low);
    const b = binOf(c.high);
    const share = (c.volume as number) / (b - a + 1);
    for (let i = a; i <= b; i++) bins[i] += share;
  }
  const total = bins.reduce((s, v) => s + v, 0);
  const mean = total / PROFILE_BINS;

  // Value area: grow outward from the POC until 70% of volume is inside.
  let poc = 0;
  for (let i = 1; i < PROFILE_BINS; i++) if (bins[i] > bins[poc]) poc = i;
  let vaLo = poc;
  let vaHi = poc;
  let inside = bins[poc];
  while (inside < total * VALUE_AREA && (vaLo > 0 || vaHi < PROFILE_BINS - 1)) {
    const below = vaLo > 0 ? bins[vaLo - 1] : -1;
    const above = vaHi < PROFILE_BINS - 1 ? bins[vaHi + 1] : -1;
    if (above >= below) inside += bins[++vaHi];
    else inside += bins[--vaLo];
  }

  const runs = (keep: (v: number) => boolean): VolumeZone[] => {
    const zones: VolumeZone[] = [];
    let start = -1;
    for (let i = 0; i <= PROFILE_BINS; i++) {
      const on = i < PROFILE_BINS && keep(bins[i]);
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        const vol = bins.slice(start, i).reduce((s, v) => s + v, 0);
        zones.push({ low: edge(start), high: edge(i), share: vol / total });
        start = -1;
      }
    }
    return zones;
  };

  return {
    from: withVol[0].time,
    poc: Math.sqrt(edge(poc) * edge(poc + 1)),
    valueAreaLow: edge(vaLo),
    valueAreaHigh: edge(vaHi + 1),
    hvnZones: runs((v) => v >= mean * 1.2),
    voidZones: runs((v) => v <= mean * 0.5),
  };
}

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return Math.max(0, hi - lo);
}

// ────────────────────────────────────────────────────────────────────
// Funnel search (bullish geometry; inverted handled by mirroring)
// ────────────────────────────────────────────────────────────────────

interface RawFunnel {
  strength: number;
  p: Pivot[]; // [1H, 1L, 2H, 2L, 3H, 3L]
  amp1: number; amp2: number; amp3: number;
  priorFrom: number; priorSize: number; priorBars: number;
}

function mirror(candles: Candle[]): Candle[] {
  return candles.map((c) => ({ time: c.time, open: -c.open, high: -c.low, low: -c.high, close: -c.close, volume: c.volume }));
}

function searchBullish(candles: Candle[]): RawFunnel[] {
  const found: RawFunnel[] = [];
  const seen = new Set<string>();
  for (const strength of PIVOT_STRENGTHS) {
    const piv = findSwings(candles, strength);
    for (let i = 0; i + 5 < piv.length; i++) {
      if (piv[i].kind !== "H") continue;
      const [h1, l1, h2, l2, h3, l3] = piv.slice(i, i + 6);
      const amp1 = h1.price - l1.price;
      const amp2 = h2.price - l2.price;
      const amp3 = h3.price - l3.price;
      if (!(amp1 > amp2 && amp2 > amp3 && amp3 > 0)) continue;
      if (amp3 > amp1 * MAX_AMP3_OF_AMP1) continue; // a funnel, not a rectangle

      const tol = amp3 * FLAT_TOLERANCE_OF_AMP3;
      if (h2.price > h1.price + tol || h3.price > h2.price + tol) continue;
      if (l2.price < l1.price - tol || l3.price < l2.price - tol) continue;

      // 1H must be the pattern's ceiling, 1L its floor, and 3H must not have
      // been exceeded before 3L printed (otherwise it already triggered).
      let ok = true;
      for (let k = h1.index; k <= l3.index && ok; k++) {
        if (candles[k].high > h1.price || candles[k].low < l1.price - tol) ok = false;
        if (k > h3.index && candles[k].high > h3.price) ok = false;
      }
      if (!ok) continue;

      // Prior trend into 1H.
      const span = Math.max(10, l3.index - h1.index);
      const from = Math.max(0, h1.index - span);
      if (from >= h1.index) continue;
      let priorLow = Infinity;
      let priorLowIdx = from;
      for (let k = from; k < h1.index; k++) {
        if (candles[k].low < priorLow) { priorLow = candles[k].low; priorLowIdx = k; }
      }
      const priorSize = h1.price - priorLow;
      if (!(priorSize >= amp1 && priorLow < l1.price)) continue;

      const key = [h1.index, l1.index, h2.index, l2.index, h3.index, l3.index].join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ strength, p: [h1, l1, h2, l2, h3, l3], amp1, amp2, amp3, priorFrom: priorLow, priorSize, priorBars: h1.index - priorLowIdx });
    }
  }
  return found;
}

// ────────────────────────────────────────────────────────────────────
// Build result
// ────────────────────────────────────────────────────────────────────

/** `candles` is the series the funnel was found in (mirrored for shorts); `realCandles` is the original. */
function toFunnel(raw: RawFunnel, candles: Candle[], realCandles: Candle[], short: boolean, profile: VolumeProfile | null): HvfFunnel {
  const sign = short ? -1 : 1;
  const [h1, l1, h2, l2, h3, l3] = raw.p;
  const pt = (p: Pivot): FunnelPoint => ({ index: p.index, time: candles[p.index].time, price: sig(p.price * sign) });

  // Mirrored-space levels (bullish geometry); convert with `sign` on output.
  const entry = h3.price;
  const stop = l3.price;
  const midway = (h3.price + l3.price) / 2;
  const target = midway + raw.amp1;
  const interim2Raw = midway + raw.amp2;
  const last = candles.length - 1;

  // Walk forward from 3L for status.
  let status: FunnelStatus = "forming";
  let trig: HvfFunnel["trigger"] = null;
  let interim2Hit = false;
  for (let k = l3.index + 1; k <= last; k++) {
    const c = candles[k];
    if (!trig) {
      if (c.high >= entry) {
        const range = c.high - c.low;
        const closeLocation = range > 0 ? (c.close - c.low) / range : 0.5;
        const vols = candles.slice(Math.max(0, k - VOLUME_AVG_BARS), k).map((x) => x.volume ?? 0);
        const avg = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
        const volumeRatio = avg > 0 && (c.volume ?? 0) > 0 ? (c.volume as number) / avg : null;
        trig = {
          index: k,
          time: c.time,
          volumeRatio: volumeRatio === null ? null : Number(volumeRatio.toFixed(2)),
          closeLocation: Number(closeLocation.toFixed(2)),
          looksReal: volumeRatio === null ? null : volumeRatio > 1 && closeLocation >= 0.6,
        };
        status = "triggered";
        if (c.high >= target) { status = "target_hit"; break; }
        if (c.low <= stop) { status = "stopped"; break; }
        continue;
      }
      if (c.close < stop) { status = "invalidated"; break; }
    } else {
      if (interim2Raw > entry && c.high >= interim2Raw) interim2Hit = true;
      if (c.low <= stop) { status = "stopped"; break; }
      if (c.high >= target) { status = "target_hit"; break; }
    }
  }
  const funnelBars = l3.index - h1.index;
  const barsSince3 = last - l3.index;
  if (status === "forming" && barsSince3 > funnelBars * STALE_MULTIPLE) status = "stale";

  const lastClose = candles[last].close;
  const distanceToEntryPct = ((entry - lastClose) / Math.abs(entry)) * 100;

  const real = (x: number) => sig(x * sign);
  const levels = {
    entry: real(entry),
    stop: real(stop),
    midway: real(midway),
    target: real(target),
    interim2: interim2Raw > entry ? real(interim2Raw) : null,
  };

  let volume: HvfFunnel["volume"] = null;
  if (profile) {
    const e = levels.entry;
    const t = levels.target;
    const binWidth = Math.abs(e) * 0.01;
    const triggerOnKlos = profile.hvnZones.some((z) => e >= z.low - binWidth && e <= z.high + binWidth);
    const heavyZonesToTarget = profile.hvnZones.filter((z) => {
      const ov = overlap(z.low, z.high, e, t);
      return ov > 0 && !(e >= z.low && e <= z.high);
    });
    const path = Math.abs(t - e);
    const voidLen = profile.voidZones.reduce((s, z) => s + overlap(z.low, z.high, e, t), 0);
    volume = { triggerOnKlos, heavyZonesToTarget, voidPathShare: path > 0 ? Number((voidLen / path).toFixed(2)) : 0 };
  }

  const notes: string[] = [];
  if (raw.p[2].price > raw.p[0].price - raw.amp3 * 0.05 || raw.p[4].price > raw.p[2].price - raw.amp3 * 0.05) {
    notes.push(short ? "flat-bottomed edge (lows roughly equal)" : "flat-topped edge (highs roughly equal)");
  }
  if (raw.p[3].price < raw.p[1].price + raw.amp3 * 0.05 || raw.p[5].price < raw.p[3].price + raw.amp3 * 0.05) {
    notes.push(short ? "flat-topped edge (highs roughly equal)" : "flat-bottomed edge (lows roughly equal)");
  }
  if (volume?.heavyZonesToTarget.length) notes.push(`${volume.heavyZonesToTarget.length} heavy volume zone(s) between entry and target — expect a stall`);
  if (trig?.looksReal === false) notes.push("trigger bar weak (volume ≤ average or close not near extreme) — possible feign & break");

  const funnel: HvfFunnel = {
    direction: short ? "short" : "long",
    pivotStrength: raw.strength,
    // Inverted HVF reads 1L,1H,2L,2H,3L,3H in Hunt's naming: mirrored highs are real lows.
    points: short
      ? { l1: pt(h1), h1: pt(l1), l2: pt(h2), h2: pt(l2), l3: pt(h3), h3: pt(l3) }
      : { h1: pt(h1), l1: pt(l1), h2: pt(h2), l2: pt(l2), h3: pt(h3), l3: pt(l3) },
    amplitudes: { amp1: sig(raw.amp1), amp2: sig(raw.amp2), amp3: sig(raw.amp3) },
    levels,
    rewardRisk: Number(((target - entry) / (entry - stop)).toFixed(2)),
    stopDistancePct: Number((((entry - stop) / Math.abs(entry)) * 100).toFixed(2)),
    targetDistancePct: Number((((target - entry) / Math.abs(entry)) * 100).toFixed(2)),
    priorTrend: { fromPrice: real(raw.priorFrom), size: sig(raw.priorSize), bars: raw.priorBars },
    funnelBars,
    barsSince3,
    status,
    trigger: trig,
    interim2Hit,
    distanceToEntryPct: Number(distanceToEntryPct.toFixed(2)),
    primer: null,
    volume,
    score: 0,
    notes,
  };
  funnel.score = scoreFunnel(funnel, realCandles);
  return funnel;
}

/**
 * Ranking score, 0-100. OUR weighting, not Hunt's — meant to be tuned by the
 * reviewer against real outcomes. Only active setups score above ~40.
 *   contraction 20 · reward:risk 25 · actionability 25 · volume layer 30
 */
export function scoreFunnel(f: HvfFunnel, candles: Candle[]): number {
  const contraction = Math.max(0, Math.min(1, (0.9 - f.amplitudes.amp3 / f.amplitudes.amp1) / 0.6)) * 20;
  const rr = Math.min(Math.max(f.rewardRisk, 0), 6) / 6 * 25;

  let actionable = 0;
  if (f.status === "forming") {
    actionable = f.distanceToEntryPct <= 3 ? 25 : f.distanceToEntryPct <= 8 ? 12 : 5;
  } else if (f.status === "triggered" && f.trigger) {
    const last = candles[candles.length - 1].close;
    const progress = (last - f.levels.entry) / (f.levels.target - f.levels.entry); // works for both directions
    const fresh = candles.length - 1 - f.trigger.index <= 3;
    actionable = f.interim2Hit ? 0 : progress < 0.25 ? (fresh ? 25 : 15) : progress < 0.5 ? 8 : 0;
  }
  // A live primer means an earlier, tighter entry into this same pattern.
  if (f.primer && (f.primer.status === "forming" || f.primer.status === "triggered") && (f.status === "forming" || f.status === "stale")) {
    actionable = Math.max(actionable, f.primer.status === "triggered" ? 25 : 18);
  }

  let vol = 15; // neutral when no volume data
  if (f.volume) {
    vol = (f.volume.triggerOnKlos ? 10 : 0) + f.volume.voidPathShare * 10 - Math.min(f.volume.heavyZonesToTarget.length, 2) * 3;
    if (f.trigger) vol += f.trigger.looksReal ? 10 : f.trigger.looksReal === false ? 0 : 5;
    else vol += 5;
  }
  return Math.round(Math.max(0, Math.min(100, contraction + rr + actionable + vol)));
}

const ACTIVE: FunnelStatus[] = ["forming", "triggered"];

/** Find every HVF (bullish and inverted) in the series and rank them. Needs ≥ 40 candles. */
export function analyzeHvfFunnels(candles: Candle[]): HvfFunnelAnalysis {
  const empty: HvfFunnelAnalysis = { best: null, funnels: [], profile: null, legacyTargets: [], assumptions: ASSUMPTIONS };
  if (candles.length < 40) return empty;

  const profile = buildVolumeProfile(candles);
  const mirrored = mirror(candles);
  const all = [
    ...searchBullish(candles).map((r) => toFunnel(r, candles, candles, false, profile)),
    ...searchBullish(mirrored).map((r) => toFunnel(r, mirrored, candles, true, profile)),
  ];
  if (all.length === 0) return { ...empty, profile };

  // Primers: nest each smaller funnel inside a same-direction parent that contains it.
  const lo = (f: HvfFunnel) => Math.min(f.points.h2.price, f.points.l2.price);
  const hi = (f: HvfFunnel) => Math.max(f.points.h2.price, f.points.l2.price);
  const first = (f: HvfFunnel) => Math.min(f.points.h1.index, f.points.l1.index);
  const secondSwing = (f: HvfFunnel) => Math.max(f.points.h2.index, f.points.l2.index);
  const lastPoint = (f: HvfFunnel) => Math.max(f.points.h3.index, f.points.l3.index);
  const isChild = new Set<HvfFunnel>();
  for (const parent of all) {
    const kid = all
      .filter((c) =>
        c !== parent &&
        c.direction === parent.direction &&
        c.amplitudes.amp1 < parent.amplitudes.amp2 &&
        first(c) >= secondSwing(parent) &&
        Math.min(c.points.h1.price, c.points.l1.price) >= lo(parent) &&
        Math.max(c.points.h1.price, c.points.l1.price) <= hi(parent))
      .sort((a, b) => lastPoint(b) - lastPoint(a))[0];
    if (!kid) continue;
    const risk = Math.abs(kid.levels.entry - kid.levels.stop);
    parent.primer = {
      entry: kid.levels.entry,
      stop: kid.levels.stop,
      status: kid.status,
      looksReal: kid.trigger?.looksReal ?? null,
      rewardRisk: risk > 0 ? Number((Math.abs(parent.levels.target - kid.levels.entry) / risk).toFixed(2)) : 0,
      points: kid.points,
    };
    parent.notes.push(`primer (squeeze within the squeeze) ${kid.status}: entry ${kid.levels.entry}, stop ${kid.levels.stop}`);
    parent.score = scoreFunnel(parent, candles);
    isChild.add(kid);
  }

  const legacyTargets = all
    .filter((f) => f.status !== "forming" && f.status !== "triggered")
    .map((f) => ({ price: f.levels.target, direction: f.direction, status: f.status, time: Math.max(f.points.h3.time, f.points.l3.time) }))
    .sort((a, b) => b.time - a.time)
    .slice(0, 8);

  // Relevance: active setups first (by score), then everything else by recency of 3L.
  all.sort((a, b) => {
    const aa = ACTIVE.includes(a.status) ? 1 : 0;
    const bb = ACTIVE.includes(b.status) ? 1 : 0;
    if (aa !== bb) return bb - aa;
    if (aa) return b.score - a.score;
    return b.points.l3.index - a.points.l3.index;
  });

  // Drop near-duplicates found at several pivot strengths (same 3H & 3L bars).
  const unique: HvfFunnel[] = [];
  for (const f of all) {
    if (!unique.some((u) => u.direction === f.direction && u.points.h3.index === f.points.h3.index && u.points.l3.index === f.points.l3.index)) {
      unique.push(f);
    }
  }
  // A primer is reported on its parent; don't also rank it as a separate setup.
  const funnels = unique.filter((f) => !isChild.has(f)).slice(0, 5);
  return { best: funnels[0] ?? null, funnels, profile, legacyTargets, assumptions: ASSUMPTIONS };
}

// ────────────────────────────────────────────────────────────────────
// Actionable setup — the one rule every consumer shares
// ────────────────────────────────────────────────────────────────────

export interface HvfSetup {
  direction: "long" | "short";
  /** "triggered" = the funnel's own 3H/3L broke; "primer" = the nested squeeze broke first */
  via: "triggered" | "primer";
  stop: number;
  target: number;
  /** Reward:risk from the current price */
  rewardRisk: number;
  funnel: HvfFunnel;
}

/** Hunt enters with resting stop orders; eToro here only takes market orders, so we
 *  enter on the first scan after the trigger and only while price is still near it:
 *  less than 25% of the way to target, before the second interim, R:R ≥ minRR.
 *  The trigger bar must not be weak (Hunt's "feign & break": volume ≤ average or close
 *  away from the extreme). On 2024-26 crypto data this was the one filter with an edge:
 *  ~+0.25R/trade vs ~0R without it (n≈46, rough tally — see docs/hvf-spec.md). */
export const MAX_PROGRESS_TO_TARGET = 0.25;
export const MIN_SETUP_RR = 2;

export function actionableSetup(analysis: HvfFunnelAnalysis, currentPrice: number, minRR = MIN_SETUP_RR): HvfSetup | null {
  const options: HvfSetup[] = [];
  for (const f of analysis.funnels) {
    const legs: { via: HvfSetup["via"]; entry: number; stop: number; live: boolean }[] = [
      { via: "triggered", entry: f.levels.entry, stop: f.levels.stop, live: f.status === "triggered" && !f.interim2Hit && f.trigger?.looksReal !== false },
    ];
    if (f.primer && f.primer.status === "triggered" && f.primer.looksReal !== false && (f.status === "forming" || f.status === "stale")) {
      legs.push({ via: "primer", entry: f.primer.entry, stop: f.primer.stop, live: true });
    }
    for (const leg of legs) {
      if (!leg.live) continue;
      const dir = f.direction === "long" ? 1 : -1;
      const progress = ((currentPrice - leg.entry) * dir) / ((f.levels.target - leg.entry) * dir);
      const beyondStop = (currentPrice - leg.stop) * dir <= 0;
      if (beyondStop || progress >= MAX_PROGRESS_TO_TARGET) continue;
      const rr = ((f.levels.target - currentPrice) * dir) / ((currentPrice - leg.stop) * dir);
      if (!(rr >= minRR)) continue;
      options.push({ direction: f.direction, via: leg.via, stop: leg.stop, target: f.levels.target, rewardRisk: Number(rr.toFixed(2)), funnel: f });
    }
  }
  options.sort((a, b) => b.funnel.score - a.funnel.score || b.rewardRisk - a.rewardRisk);
  return options[0] ?? null;
}

/** Compact, number-first view of a funnel for the agent's context window. Points use Hunt's names (1H, 3L…). */
export function summarizeFunnel(f: HvfFunnel) {
  const when = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  const points = Object.fromEntries(
    Object.entries(f.points).map(([k, p]) => [`${k[1]}${k[0].toUpperCase()}`, `${p.price} @ ${when(p.time)}`]),
  );
  return {
    direction: f.direction,
    status: f.status,
    score: f.score,
    points,
    levels: f.levels,
    rewardRiskFromEntry: f.rewardRisk,
    stopDistancePct: f.stopDistancePct,
    targetDistancePct: f.targetDistancePct,
    distanceToEntryPct: f.distanceToEntryPct,
    interim2Hit: f.interim2Hit,
    trigger: f.trigger,
    primer: f.primer && { entry: f.primer.entry, stop: f.primer.stop, status: f.primer.status, rewardRisk: f.primer.rewardRisk },
    volume: f.volume && {
      triggerOnKeyLevel: f.volume.triggerOnKlos,
      heavyZonesBeforeTarget: f.volume.heavyZonesToTarget.map((z) => `${Number(z.low.toPrecision(5))}–${Number(z.high.toPrecision(5))}`),
      voidPathShare: f.volume.voidPathShare,
    },
    funnelBars: f.funnelBars,
    barsSince3: f.barsSince3,
    notes: f.notes,
  };
}
