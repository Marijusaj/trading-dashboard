# HVF (Hunt Volatility Funnel) — working spec for the detector

Status: **draft, not yet coded.** Every rule carries a confidence level and its source.
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
- **Confluence:** Fibonacci 50 / 61.8, volume-by-price levels, OBV, and the higher-timeframe
  ("macro") funnel. These are confirmation only; no indicator defines the pattern. High.

## 6. Sizing and conduct (High — FH-jk, FH-tg)

- "Cut your number of trades by three."
- Size small enough that you are "almost indifferent" to the P&L swings. "The move makes
  the money, not the sizing."
- A tighter stop does not justify a bigger position, except a primer stop.
- Don't tinker with a running macro trade. Check yourself with "would I reverse here?"
- Scale in small at key levels on pullbacks, using limit orders.

## 7. Still to confirm from Hunt's own charts

1. First-interim formula.
2. Validity rules for 2H/3H and the "not too big an impulse" limit.
3. Any buffer on the entry and stop lines.
4. How he draws the stop when there is a primer versus none.
5. The time-target / line-of-efficiency formula.
6. When an unbroken funnel counts as invalidated: for example, does a close beyond 3L
   before the 3H trigger cancel the long setup?
