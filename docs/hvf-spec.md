# HVF (Hunt Volatility Funnel) — working spec for the detector

Status: **implemented** in `src/lib/agent/hvf-funnel.ts` (2026-10-11). Open questions are in §7. Every rule carries a confidence level and its source.
Rules below **High** must be confirmed against Francis Hunt's own annotated charts
before the detector depends on them. Compiled 2026-10-11.

Sources:
- **[FH-doc]** Hunt's own write-up, *"HVF Original or Just a Symmetrical Triangle"*. Pages
  1-4 are readable; page 5 is truncated after rule (g).
- **[FH-tg]** Hunt interview, Trade Gate Hub, 2022 (YouTube `EAenYWtP9XA`). He annotates
  live charts in it.
- **[FH-fb]** Hunt interview, "HVF trading system / false breaks" (YouTube `qvSvVHX2I7U`).
- **[FH-jk]** Jay Kim Show #148 transcript (2020).
- **[MT]** Mundotrading summaries of Hunt (2017).
- **[RPT]** ratiopatterntrader (2013).
- **[FH-hvf1]** Hunt's "HVF1" lesson (BTC 2017–2019, recorded May 2019): transcript and stills
  supplied by the owner, matched by timestamp.
- **[FH-hvf2]** Hunt's "HVF2" lesson (Factom/BTC, June 2017): transcript and a still supplied by the owner.
- Transcripts live in `docs/sources/hunt/` on the owner's machine. They are git-ignored, so
  third-party content is never published.
- **[UM]** "HVF Method — Under the Microscope", a community guide. Only its table of
  contents and page headers are visible.

## 1. Geometry

```
 bullish HVF (continuation of an uptrend)       inverted HVF = mirror after a downtrend
   1H                                            
   |\        2H
   | \      /\       3H ───── green line = ENTRY (buy-stop)      ┐ "funnel region"
   |  \    /  \  /\ /                                             │  (3H..3L)
   |   \  /    \/  3L ───── red line   = STOP                     ┘
   |    \/     2L        midway line = (3H+3L)/2
   |    1L
 prior trend ↑ exhausts at 1H
```

| Rule | Conf. | Source |
|---|---|---|
| A clear prior trend is required. Setups out of choppy/flat markets "are rejected and cannot be HVFs" | High | FH-doc |
| The pattern starts at the trend's exhaustion point (1H for bullish, 1L for inverted). Points are taken only after it | High | FH-doc |
| Three alternating highs and lows. Each high is lower and each low higher than the previous ("we seek 3 alternating highs and lows") | High | FH-doc, RPT, UM |
| ...but one edge may be **flat** (equal highs or lows). Hunt calls BTC's 2018 ~$6k base a "low-slung **flat-bottomed** inverted HVF", which broke down for a 60+ R trade. So the detector must accept a flat edge with tolerance; strict monotone on both edges is wrong | High | FH-hvf1 (annotated chart, ~11:30–15:19) |
| The funnel's trigger edge usually sits on a **key level of significance (KLOS)**: a high-volume shelf on the volume-by-price histogram | Medium-high | FH-hvf1 (~4–10 min) |
| Every point must be a real price swing. Horizontal levels take precedence over angled trend lines ("a trend line price level without corroboration of price action is irrelevant") | High | FH-doc |
| It is a continuation pattern: trade in the direction of the prior trend | High | FH-doc, RPT, FH-fb ("it's continuation normally") |
| Points may be **re-adjusted** while the pattern forms (a new 3L/2L replaces the old one) | Medium | UM (ToC: "re-adjustment of 3L / 2L point") |
| "We don't want too big of an impulse" — some size limit on swings inside the funnel | Low (rule text unseen) | UM p.14 header |
| Which swings count as a valid 2H/3H | **Unknown** | UM p.13 ("valid 2H", "valid 3H"), not visible |

## 2. Orders

| Rule | Conf. | Source |
|---|---|---|
| Never enter at market. Entry, stop and target are all pending orders set in advance ("tripwire") | High | FH-jk, FH-doc, MT |
| Entry = buy-stop at the break of **3H** (sell-stop at **3L** for inverted) — the "green line" | High | FH-tg, RPT, UM |
| Stop = the opposite funnel edge, **3L** for longs (3H for shorts) — the "red line". Hunt: "the first green line and the first red line, that's your entry and that's your stop"; "stop at the red, green is your short" | Medium-high | FH-tg (spoken while drawing; colours not seen by us) |
| Know the full R:R before entry. Published trades run 2.9–62.5 R | High | FH-jk |
| Buffer beyond 3H/3L for entry or stop | **Unknown** | — |

## 3. Targets

| Rule | Conf. | Source |
|---|---|---|
| Final target = AMP1 = \|1H − 1L\| projected from the **midway line** (3H+3L)/2, in the breakout direction | Medium-high | RPT, UM ("projection from midway line"), FH-doc (AMP1 is the primary target amplitude) |
| Second interim = \|2H − 2L\| projected from the same midway line | Medium | UM p.18 text |
| A first interim exists; there are usually two ("a first and a second"). Clustered interims mean a long pause ("hang time") | Medium | FH-tg |
| How the first interim is calculated | **Unknown** | — |
| Exit at the target via a resting order. A trailing stop is an unsuitable exit. Partial profits at interims or key levels are acceptable | High | MT, FH-tg, FH-jk |
| Over-performance past the target is managed with "trumpets" (broadening structures) and "slides" (the bearish equivalent) | Medium | FH-tg |
| A time target / "line of efficiency": price should reach the target within a time window | Medium (formula unknown) | UM ToC, Hunt Instagram |

## 4. Breakout behaviour ("five stages")

1. **Feign & break** — price pokes through the line ("electric fence") on **average or
   below-average volume**, often leaving a tall wick, then falls back into the funnel.
2. **Second chance** — re-entry inside the funnel at a better price. The pattern has
   already triggered.
3. **Capitulation** — the real run: an expansive candle on big volume, closing near the
   high.
4. **Weak buying/selling overcome** — late chasers, often at an interim.
5. **Counter-attack & progress decay** — target made, then a pullback. We are already out
   via the resting take-profit.

Conf.: High for the existence and order of the stages (FH-fb, MT). Rules to tell a fake
break from a real one (volume vs average, candle closes near its extreme, wick size):
Medium-high, Hunt's own words (FH-fb).

## 5. Refinements

- **Primer** = a squeeze within the squeeze, i.e. a smaller HVF inside the funnel. It gives
  an earlier entry and lets the stop "come up to this red level" (the inner 3L), which
  allows bigger size. Medium, FH-tg.
- **Blow-off → "slap in the face" → squeeze** marks the first setup of a new trend. That is
  how he traded the RUB reversal. Medium, FH-tg.
- **KLOS via volume-by-price:** high-volume price shelves are the levels the market reacts
  to. Price travels fast through thin zones and stalls in "heavy traffic", so targets and
  interims that land in heavy traffic are likelier to pause there. Medium-high, FH-hvf1.
  The meaning of the percentages he writes on the profile (15% / 30% / 70% / 5–10%) still
  needs the audio.
- **Confluence:** Fibonacci 50 / 61.8, volume-by-price levels, OBV, and the higher-timeframe
  ("macro") funnel. These are confirmation only; no indicator defines the pattern. High.

## 5b. Volume-by-price layer (HVF1 lesson, transcript matched to the owner's stills)

These rules are Medium-high: Hunt's own words, spoken while drawing on the chart.

- **Anchor** the volume profile at a significant breakout or low (BTC: the first close above
  $3k), or at the cycle high for a bear-market profile, and run it to today. Use log scale on
  big timeframes. The anchor changes the numbers but rarely the message.
- **KLOS = high-volume nodes.** These are the levels "the market shows you", not round
  numbers. Treat them as **zones** with hard and soft floors and ceilings, not lines.
- **Value area = 70%** of the volume, leaving roughly 15% tails above and below.
- **Voids & vacuums (V&V)** = low-volume gaps between nodes. Price crosses them fast ("easy,
  quick, big profits"); entering a high-volume node ("heavy traffic") slows it down.
- **Detector use:**
  1. The funnel's trigger edge is better when it sits on a KLOS ("justified our access
     level").
  2. A setup is better when the path from entry to target runs through a void.
  3. If a heavy node sits between entry and target, expect a stall there: treat it as an
     interim or cut expected R.
  4. The breakout candle often fires exactly where the profile drops away.
- **Revisiting a heavily traded zone:** expect a skirmish and knock-back, a new wind-up
  squeeze, a momentum break, then a relapse to retest the zone as support. Don't expect a
  first-touch break.
- **Blow-off tops are thin-volume** ("thin edge of a wedge", "on fumes"). Few traders got in
  or out there.
- **Continuation bias** is explicit: he does not trade the counter-move, even when it costs
  him.
- **Macro hook:** "BTC, the god market, permissions the recovery". Alts follow BTC's lead.
  Trade liquid majors. This rule belongs to the weekly Macro Analyst.

## 5c. From the HVF2 lesson (Hunt's own words — Medium-high)

- **The primer is the real entry.** "Squeeze within the squeeze… that was your actual break of the
  main pattern." The detector nests same-direction funnels inside the parent's second-swing band
  and reports them as `primer`.
- **The entry line is "the axis".** "The 0.4 round number is the axis… high three and low three,
  and you project up from there." This confirms the target projects from the 3H/3L zone.
- **Interims cause pullbacks.** "Run up almost to the second interim, pulled back to the first,
  another run up." After the second interim: "be cautioned against charging in… you may just get
  straight into a pullback." The detector sets `interim2Hit`, and those setups are no longer
  actionable.
- **Legacy targets stay live.** An old funnel's target "ran straight through this high" much
  later. The detector lists them as `legacyTargets`.
- **Point selection matters.** A student's funnel "was a bit wide", which gave a different
  target.
- **Process.** Take money at the target, sit out the pullback, re-enter on the next setup, and
  keep the money elsewhere in between.

## 5d. First evidence from our own data (2026-10-11)

Rough tally, not a backtest: 88 funnels that resolved, from about 1,000 candles each of 12
coins, on 1d and 4h. Entry is assumed at the funnel level, with no fees or slippage.

| Filter | n | Hit rate | Expectancy |
|---|---|---|---|
| All funnels | 88 | 33% | 0.00 R |
| R:R ≥ 2 | 44 | 25% | 0.00 R |
| **Trigger looks real** (volume > average, close near the extreme) | 46 | 39% | **+0.23 R** |
| **R:R ≥ 2 and trigger looks real** | 23 | 30% | **+0.27 R** |
| Trigger on KLOS | 79 | 33% | 0.01 R |
| Shorts / longs | 50 / 38 | 38% / 26% | +0.07 / −0.09 R |

**Key levels, revisited (2026-10-13).** The first KLOS flag fired on 90% of funnels because the
profile included the funnel's own bars: a squeeze stacks volume inside itself. KLOS are now the 5
largest volume peaks in the history before the funnel's first point. The flag now fires on 39 of 85
funnels, but shows no edge: on a key level −0.02 R, off one −0.08 R, and real trigger on vs off a
key level +0.10 / +0.15 R (n = 18–43). It stays as information for the agent and is not used as a
filter.

What we did with it:
- Hunt's own breakout-quality rule is the only filter with an edge. `actionableSetup` now
  requires the trigger not to be weak.
- The KLOS flag fires on 90% of funnels, so as built it carries no information. The
  high-volume threshold needs tightening; see §7.
- The samples are small. The Reviewer agent should keep extending this table with live
  outcomes.

## 6. Sizing and conduct (High — FH-jk, FH-tg)

- "Cut your number of trades by three."
- Size small enough that you are "almost indifferent" to the P&L swings. "The move makes
  the money, not the sizing."
- A tighter stop does not justify a bigger position, except a primer stop.
- Don't tinker with a running macro trade. Check yourself with "would I reverse here?"
- Scale in small at key levels on pullbacks, using limit orders.

## 7. Still to confirm or build

- **Pending entry orders.** Hunt rests a buy-stop at 3H. eToro's resting orders (v1
  `limit-orders`, v2 `orders` with `orderType: mit`) only trigger at a price *better* than
  current: below price for longs, above for shorts. So a breakout buy-stop can't be placed. What
  is possible is Hunt's **"second chance"** entry: after the trigger, rest a buy MIT back at 3H
  with the stop at 3L, filled only on a retest. Not built; it needs the owner's decision.

From Hunt's own charts:

1. First-interim formula.
2. Validity rules for 2H/3H and the "not too big an impulse" limit.
3. Any buffer on the entry and stop lines.
4. How he draws the stop when there is a primer versus none.
5. The time-target / line-of-efficiency formula.
6. When an unbroken funnel counts as invalidated: for example, does a close beyond 3L
   before the 3H trigger cancel the long setup?
