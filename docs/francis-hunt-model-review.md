# Francis Hunt model — review of what the agent believes (2026-10-11)

Sources: the five transcripts in the local `docs/` folder (not committed), five
chart screenshots, and public write-ups of the HVF method (links at the end).
Prices checked 2026-10-11 (CoinGecko): BTC $83.0k, BTC.D 59.7%, USDT.D 6.6%,
TRX $0.330, XRP $1.39, SOL $109, LINK $12.9, XLM $0.198, HBAR $0.092, ZEC $1,232.

## 1. Verdict

| What the agent believes | Status |
|---|---|
| "HVF" = 0-100 score from ATR squeeze + EMA 20/50/200 stack + volume contraction + 2% pivot proximity | **Wrong.** HVF is a pivot-geometry pattern; Hunt explicitly rejects indicator rules. |
| SL = tighter of 1.5×ATR / last pivot; TP = max(last high, 1.5R); trail to breakeven, scale out at +1R | **Not his.** Stop is structural; target is a measured projection; he says trailing stops are an unsuitable exit and "tight stops kill good trades". |
| BTC bear flag → targets 46.5k / 37k | **Stale.** March 2026 call. By May he said "the technical flag as a bear flag has been abandoned". BTC now 83k. |
| "If BTC is in a bear flag, lean SHORT on alts"; Binance: "alts generally bear-aligned per Francis" | **Stale and now inverted.** Latest video is an explicit bottom call and "alt run that is here on balance of probabilities". |
| USDT.D → 10%+, "May crash" | **Failed / expired.** USDT.D is 6.6%. |
| Per-asset theses in `universe.ts` (XRP "sub-$1 target", SOL "bear flag -37%") | **Stale.** XRP hit 0.98 (target made) and turned; he now names XRP/SOL as "chosen" alts. |
| TRX long, TRX/BTC outperformance, pricing things in gold | **Still his view**, consistent across all videos. |

## 2. How the HVF method actually works

```
 bullish HVF (continuation after an uptrend)        inverted HVF = mirror image
   1H
   |\        2H
   | \      /\       3H ── buy-stop entry at break of 3H
   |  \    /  \  /\ /
   |   \  /    \/  3L ── stop: structural, beyond 3L ("more likely wrong than right")
   |    \/     2L
   |    1L
 target  = (1H − 1L) projected from midpoint(3H, 3L)
 interim = (2H − 2L) projected from the same midpoint — expect a pause / take partial
```

- Needs a **clear prior trend** that exhausts at 1H (1L for the bearish case).
  Setups that come out of flat chop are rejected.
- Three swings, **each smaller than the one before** (lower highs, higher lows),
  using real swing pivots. Horizontal levels matter more than trend lines.
- **Entry by pending order** at the break of 3H/3L, "never at market". There are also
  variants: early entry, and a "second chance" entry on the retest.
- **Exit at the predefined target**, taking partials at interims. Hold winners for
  large R. His published trades run 2.9–13.5 R, and he judges R:R against time
  ("RRR ÷ T").
- **Indicators:** none, except volume / OBV as *confirmation* (May video: "a rally
  on volume well below average is not conviction"). He also uses Fibonacci and
  Point-and-Figure targets for confluence.
- **Other patterns** he trades alongside HVF:
  - bear/bull flags (measured move = flagpole)
  - head-and-shoulders / inverse H&S ("armpit 1 / armpit 2" = the A1/A2 on the TRX/BTC chart)
  - W bottoms and M tops
  - return moves to necklines
- **Scale:** big-timeframe targets on log scale, with the linear projection as the
  extreme case. Rule: "a weak counter-trend after a target is made usually leads to
  continuation".
- **Sizing:** "cut your trading volume by three". Pots:
  - blue pot: unleveraged, long-term
  - moderate pot: 3–5x leverage
  - "hot pot": high leverage, which you have to earn the right to use
  - profits are "taxed" from trading into the blue pot

## 3. How he reads the market (top-down)

He always starts at the macro level and only then zooms into coins:

1. **Fiat/debt stress:**
   - the dollar
   - yen and Japan
   - KRW
   - Treasuries and credit contagion
   - Fed/Treasury liquidity

   His frame: "bad news in trad is good news for crypto and gold".
2. **Anti-fiat firing order:** gold → silver/miners → BTC → large alts → smaller alts.
   "Those that come later often pump harder." Gold breaking out is the leading signal.
3. **Gold as unit of account:**
   - the 1/XAUUSD "debasement line" on every chart
   - assets priced in gold (TRX/gold, NASDAQ/gold)
4. **Crypto internals:**
   - BTC.D (inverted)
   - USDT.D
   - TOTAL3/BTC
   - ratio charts (TRX/BTC, SOL/BTC)

   Check SOLUSD too, because a rising alt/BTC ratio "could be as much BTC going down".
5. **Then single coins** (patterns above).

## 4. The alt blow-off — what he actually projects

Timeline of his calls:

| When | BTC | Alt stance |
|---|---|---|
| 22 Mar 2026 | ~70k | BTC bear flag. "Other alts… could go down faster than Bitcoin." Only TRX favoured (TRX/BTC inverse H&S, ~3.7x target). |
| ~Apr 2026 | ~77k | USDT.D to double digits, "May crash", TRX to flip SOL. |
| ~May 2026 | ~82k | Bear flag abandoned (hedged). Selective: TRX and XMR bullish; ADA/DOT/NEAR/ICP/HBAR/XLM/SUI/UNI bleeding. |
| ~Aug 2026 | <75k | BTC will underperform alts. TOTAL3/BTC "not ready — needs a third impulse"; real alt breakout "2027 or later". |
| ~Sep/Oct 2026 (latest) | — | **Bottom call.** Debt crisis entering a "quickening" stage, so anti-fiats run. "Like silver, the alts will outperform Bitcoin." Chosen alts: XRP (HVF target $19.35 unchanged, has a 2nd interim to pause at), XLM, LINK, SOL, TRX, HBAR, ZEC. **Warns of a leverage flush first.** |

**Inverted BTC.D monthly chart** (his big picture, 2018→2029 funnel):

```
 BTC.D now ~60% ──▶ ~52% (mid-2027) ──▶ back to ~60% (early 2028) ──▶ breakout ──▶ 27.5% (2028-29)
                     first alt wave       shakeout / "V" dip              ALT BLOW-OFF
```

**His SOL roadmap** (same shape on SOL/BTC):
- a third high that is likely lower than the previous two
- a listless pullback
- then "pause, go very low, V" — he calls this "the sniper warning sign"

**What this means for the agent:**
- The **directional bias on alts flips from short to long**, but this is a multi-year,
  staged move rather than an imminent spike.
- **Expect a leverage flush before the run.** Shorts on alts no longer match the thesis.
- **Use BTC.D, TOTAL3/BTC and gold as regime gates.** Alt longs make sense when BTC.D
  is falling, TOTAL3/BTC is breaking up, and gold leads.
- **Plan the exit as well as the entry.** He expects a blow-off and then a sharp "V"
  drop. Targets and interims, not "HODL", are the exit plan, and the BTC.D 27.5% zone
  is where the alt cycle ends.
- **His record:** the March BTC targets (46.5k/37k) were never reached, and USDT.D 10%
  failed. Treat each call as a probability with an invalidation level, not as fact.

## 5. Pipeline proposal — separate agents, separate cadences

The world doesn't change daily, so one agent shouldn't redo the macro read on every
scan. There are three agents. Each writes a stored artifact, and the next one reads
it rather than recomputing it.

```
 BEFORE (one agent, daily)              AFTER (three agents, own cadence)
 cron 12:00 ─▶ FrancisAgent             WEEKLY  Macro Analyst ──▶ macro_regime (row/week)
   ├ indicator "HVF" score                 DXY, USDJPY, KRW, US10Y, gold, silver,
   ├ hardcoded thesis strings              1/XAU, BTC.D, USDT.D, TOTAL3/BTC
   └ open/close trades                     → regime, firing-order stage, alt-cycle stage,
                                             per-asset bias + invalidation levels
                                                 │ read-only input
                                        DAILY   Trader (existing loop) ◀──┘
                                           real HVF/flag/H&S detector → entry/stop/target
                                           may only trade WITH the weekly bias
                                                 │ every trade stamped with regime id
                                        WEEKLY  Reviewer ──▶ lessons (after the macro run)
                                           outcome × regime × pattern → what pays
```

why: the slow layer (world) sets direction and permissions. The fast layer (trader)
only times entries. Separating them makes every trade traceable to the regime it
was taken in, which is what builds our own body of knowledge.

Design points to settle before building:
- **Macro Analyst output contract.** One `macro_regime` row per week:
  - `risk_on_off`
  - `firing_order_stage` (gold → silver → BTC → alts)
  - `alt_cycle_stage` (bleed / basing / first wave / shakeout / blow-off)
  - per-asset `bias` (long / short / flat), each with an invalidation level
  - a free-text rationale

  Invalidation levels let the daily trader react mid-week without re-running macro.
- **Mid-week break.** If an invalidation level is crossed, the trader goes flat on
  that asset until the next weekly run. Alternative: let the break trigger an early
  macro run.
- **Data sources.** CoinGecko for dominance and TOTAL3; eToro/Yahoo candles for FX,
  gold and yields.
- **Hunt's videos as one input among several**, not as truth. The analyst can ingest
  new transcripts, but its own chart read and the reviewer's lessons carry equal
  weight.

## Sources (HVF mechanics)
- Hunt, "HVF Original or Just a Symmetrical Triangle": https://www.scribd.com/document/325490912/HVF-Original-or-Just-a-Symmetrical-Triangle
- https://ratiopatterntrader.wordpress.com/patterns/
- https://mundotrading.net/2017/04/30/the-hunt-volatility-funnel-hvf-theory-part-22-by-alvaro-rivero/
- Jay Kim interview transcript: https://jaykimshow.com/2020/09/francis-hunt-transcript/
- https://themarketsniper.com/macro-event-trades-oil-case-studyv2/
