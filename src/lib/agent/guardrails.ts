// Guardrails: enforced limits that no agent decision can bypass.
// All trade execution flows through checkGuardrails() before hitting eToro.
//
// These are intentionally CONSERVATIVE and live in code (not prompt) so
// the LLM cannot talk itself out of them.
import { db } from "@/lib/neon";
import { checkMarketHours, type AssetClass } from "./market-hours";
import type { AgentEnvironment, GuardrailStateRow } from "@/lib/neon";

export interface GuardrailLimits {
  maxPositionSizeUsd: number;
  maxConcurrentPositions: number;
  maxDailyLossUsd: number;          // absolute, positive value
  minMinutesBetweenEntries: number;
  minRewardRiskRatio: number;
  maxLeverage: number;
  cooldownAfterConsecutiveLosses: number; // hours
}

export const LIMITS: Record<AgentEnvironment, GuardrailLimits> = {
  real: {
    maxPositionSizeUsd: 100,         // raised from $50 — user wants more capital deployed on Real
    maxConcurrentPositions: 3,
    maxDailyLossUsd: 60,             // 6% of $1k effective ceiling
    minMinutesBetweenEntries: 240,   // 4h
    minRewardRiskRatio: 1.5,
    maxLeverage: 1,
    cooldownAfterConsecutiveLosses: 24,
  },
  paper: {
    // Paper is the testing lab: many small trades a day, so no forced gap
    // between entries and no loss-streak cooldown. The daily loss cap and
    // the concurrent-position cap still bound it.
    maxPositionSizeUsd: 15_000,      // raised from $5k — paper has $181k idle, deploy more
    maxConcurrentPositions: 8,
    maxDailyLossUsd: 12_000,         // 6% of ~$200k equity
    minMinutesBetweenEntries: 0,
    minRewardRiskRatio: 1.5,
    maxLeverage: 2,
    cooldownAfterConsecutiveLosses: 0,
  },
  binance: {
    // Spot USDC, long-only. Conservative initial sizing on a $500 USDC balance.
    maxPositionSizeUsd: 50,           // 10% of $500 dry powder per trade
    maxConcurrentPositions: 5,
    maxDailyLossUsd: 30,              // 6% of $500
    minMinutesBetweenEntries: 240,    // 4h
    minRewardRiskRatio: 1.5,
    maxLeverage: 1,                   // spot has no leverage
    cooldownAfterConsecutiveLosses: 24,
  },
};

/**
 * Environments where the AGENT enforces the stop, not the broker.
 *
 * eToro will not hold a tight stop: anything closer than ~10% of the
 * invested amount is silently moved out to that floor (observed on every
 * 15m trade Jul–Nov 2026), which made a 1–2% funnel stop impossible to
 * place. In these environments the trade's real stop/target live in the
 * `trades` row and stop-monitor.ts closes the position when price crosses
 * them; the broker only gets a wide safety stop (see brokerSafetyStop).
 */
export function usesManagedStops(env: AgentEnvironment): boolean {
  return env === "paper";
}

/** Tightest managed stop we accept, % from entry — below this the spread
 *  alone would trip it on the first monitor pass. */
export const MANAGED_MIN_SL_PCT = 0.3;

/** Safety stop sent to the broker for a managed-stop trade, as % of the
 *  invested amount — just outside eToro's 10% floor so it is kept as sent. */
export const BROKER_SAFETY_STOP_PCT = 12;

/** Broker-side stop for a managed trade: the safety distance, or the
 *  agent's own stop when that is already further out. */
export function brokerSafetyStop(
  entryPrice: number,
  stopLoss: number,
  direction: "long" | "short",
  leverage: number,
): number {
  const pct = BROKER_SAFETY_STOP_PCT / Math.max(1, leverage) / 100;
  const safety = direction === "long" ? entryPrice * (1 - pct) : entryPrice * (1 + pct);
  const wider = direction === "long" ? Math.min(stopLoss, safety) : Math.max(stopLoss, safety);
  return Number(wider.toPrecision(6));
}

export interface ProposedTrade {
  environment: AgentEnvironment;
  asset: string;
  sizeUsd: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  entryPrice: number;
  direction: "long" | "short";
  // From universe entry — eToro min position size for this asset class
  minSizeUsd?: number;
  // From universe entry — used for market-hours check
  assetClass?: AssetClass;
}

export interface GuardrailResult {
  allowed: boolean;
  violation: string | null;
  details: Record<string, unknown>;
}

/** Killswitch — set AGENT_DISABLED=true in Vercel to halt all trading. */
export function isKillswitchActive(): boolean {
  return process.env.AGENT_DISABLED === "true";
}

async function loadState(env: AgentEnvironment): Promise<GuardrailStateRow> {
  const sql = db();
  const rows = await sql`
    SELECT * FROM guardrail_state WHERE environment = ${env}
  ` as unknown as GuardrailStateRow[];
  if (rows.length === 0) {
    // Lazy-init if missing
    await sql`INSERT INTO guardrail_state (environment) VALUES (${env}) ON CONFLICT DO NOTHING`;
    const fresh = await sql`SELECT * FROM guardrail_state WHERE environment = ${env}` as unknown as GuardrailStateRow[];
    return fresh[0];
  }
  return rows[0];
}

/** Roll the daily P&L window if the last reset was on a previous UTC day. */
async function maybeResetDaily(env: AgentEnvironment, state: GuardrailStateRow): Promise<GuardrailStateRow> {
  const last = new Date(state.daily_reset_at);
  const now = new Date();
  const sameDay =
    last.getUTCFullYear() === now.getUTCFullYear() &&
    last.getUTCMonth() === now.getUTCMonth() &&
    last.getUTCDate() === now.getUTCDate();
  if (sameDay) return state;
  const sql = db();
  await sql`
    UPDATE guardrail_state
       SET daily_realized_pnl = 0,
           daily_reset_at     = now()
     WHERE environment = ${env}
  `;
  return { ...state, daily_realized_pnl: 0, daily_reset_at: now.toISOString() };
}

/** Single source of truth: can this trade proceed? */
export async function checkGuardrails(trade: ProposedTrade): Promise<GuardrailResult> {
  if (isKillswitchActive()) {
    return { allowed: false, violation: "killswitch", details: { reason: "AGENT_DISABLED=true" } };
  }

  const limits = LIMITS[trade.environment];
  const state = await maybeResetDaily(trade.environment, await loadState(trade.environment));

  // 1a. Position size — must be at most env max
  if (trade.sizeUsd > limits.maxPositionSizeUsd) {
    return {
      allowed: false,
      violation: "max_position_size",
      details: { proposed: trade.sizeUsd, max: limits.maxPositionSizeUsd },
    };
  }

  // 1b. Position size — must clear eToro's per-asset minimum
  if (trade.minSizeUsd && trade.sizeUsd < trade.minSizeUsd) {
    return {
      allowed: false,
      violation: "below_etoro_min_size",
      details: {
        proposed: trade.sizeUsd,
        min: trade.minSizeUsd,
        hint: `eToro requires min $${trade.minSizeUsd} for ${trade.asset}. Skip this asset on ${trade.environment} or pick a different setup.`,
      },
    };
  }

  // 1c. Market must be open. CFDs (commodity) closed weekends, equities
  //     only during NYSE hours, etc. Crypto always open.
  if (trade.assetClass) {
    const hours = checkMarketHours(trade.assetClass);
    if (!hours.isOpen) {
      return {
        allowed: false,
        violation: "market_closed",
        details: {
          assetClass: trade.assetClass,
          reason: hours.reason,
          nextOpenUtc: hours.nextOpenUtc,
        },
      };
    }
  }

  // 2. Leverage
  if (trade.leverage > limits.maxLeverage) {
    return {
      allowed: false,
      violation: "max_leverage",
      details: { proposed: trade.leverage, max: limits.maxLeverage },
    };
  }

  // 3. Concurrent positions
  if (state.open_position_count >= limits.maxConcurrentPositions) {
    return {
      allowed: false,
      violation: "max_concurrent_positions",
      details: { current: state.open_position_count, max: limits.maxConcurrentPositions },
    };
  }

  // 4. Daily loss cap
  if (-state.daily_realized_pnl >= limits.maxDailyLossUsd) {
    return {
      allowed: false,
      violation: "daily_loss_cap",
      details: { realized: state.daily_realized_pnl, cap: limits.maxDailyLossUsd },
    };
  }

  // 5. Cooldown after consecutive losses
  if (state.cooldown_until) {
    const until = new Date(state.cooldown_until);
    if (until > new Date()) {
      return {
        allowed: false,
        violation: "cooldown_active",
        details: { until: until.toISOString(), consecutive_losses: state.consecutive_losses },
      };
    }
  }

  // 6. Min time between entries
  if (state.last_entry_at) {
    const last = new Date(state.last_entry_at).getTime();
    const minsSince = (Date.now() - last) / 60_000;
    if (minsSince < limits.minMinutesBetweenEntries) {
      return {
        allowed: false,
        violation: "min_time_between_entries",
        details: { mins_since_last: Math.round(minsSince), required: limits.minMinutesBetweenEntries },
      };
    }
  }

  // 7. Stop loss + take profit must exist (no 0 / NaN / on-wrong-side)
  if (!isFinite(trade.stopLoss) || !isFinite(trade.takeProfit)) {
    return { allowed: false, violation: "missing_stop_or_target", details: {} };
  }
  if (trade.direction === "long") {
    if (trade.stopLoss >= trade.entryPrice) {
      return { allowed: false, violation: "stop_above_entry_long", details: { stop: trade.stopLoss, entry: trade.entryPrice } };
    }
    if (trade.takeProfit <= trade.entryPrice) {
      return { allowed: false, violation: "target_below_entry_long", details: { target: trade.takeProfit, entry: trade.entryPrice } };
    }
  } else {
    if (trade.stopLoss <= trade.entryPrice) {
      return { allowed: false, violation: "stop_below_entry_short", details: { stop: trade.stopLoss, entry: trade.entryPrice } };
    }
    if (trade.takeProfit >= trade.entryPrice) {
      return { allowed: false, violation: "target_above_entry_short", details: { target: trade.takeProfit, entry: trade.entryPrice } };
    }
  }

  // 8. Min reward:risk
  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  const reward = Math.abs(trade.takeProfit - trade.entryPrice);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < limits.minRewardRiskRatio) {
    return {
      allowed: false,
      violation: "min_reward_risk",
      details: { proposed: Number(rr.toFixed(2)), min: limits.minRewardRiskRatio },
    };
  }

  // 9. Min SL distance per asset class — eToro silently widens too-tight stops.
  //    Observed 2026-04-27: agent set 0.27% SL on LINK short, eToro widened
  //    to 5%, destroying R:R from 2.6 → 0.14. We must respect the platform
  //    minimums BEFORE submitting to keep R:R honest.
  const slDistancePct = (risk / trade.entryPrice) * 100;
  //    Managed-stop environments enforce the stop themselves, so only the
  //    spread floor applies there.
  const managed = usesManagedStops(trade.environment);
  const minSlPct = managed
    ? MANAGED_MIN_SL_PCT
    : MIN_SL_DISTANCE_PCT[trade.assetClass || "crypto"][trade.direction] ?? 1;
  if (slDistancePct < minSlPct) {
    return {
      allowed: false,
      violation: "stop_too_tight_for_etoro",
      details: {
        proposedSlPct: Number(slDistancePct.toFixed(2)),
        minSlPct,
        hint: managed
          ? `Stop is inside the spread. Use SL >= ${minSlPct}% from entry.`
          : `eToro silently widens stops below platform minimum, destroying R:R. Use SL >= ${minSlPct}% from entry.`,
      },
    };
  }

  return { allowed: true, violation: null, details: { rewardRiskRatio: Number(rr.toFixed(2)) } };
}

/** Minimum SL distance (% from entry) eToro will respect WITHOUT widening.
 *  Padded ~0.5pp above the documented eToro minimums because the broker
 *  has been observed silently pushing stops up an extra 5-15% (e.g.
 *  agent submits 5.10% on crypto short → eToro widens to 5.97% → R:R
 *  degrades and post-trade verification auto-closes the trade).
 *  The extra buffer means agent-submitted SLs land inside the
 *  "no-widening" zone, which keeps trades alive. */
const MIN_SL_DISTANCE_PCT: Record<string, { long: number; short: number }> = {
  crypto:    { long: 1.5, short: 5.5 },  // shorts get widened most aggressively
  commodity: { long: 2.5, short: 2.5 },  // CFD margin-based
  equity:    { long: 1.5, short: 1.5 },
  etf:       { long: 1.5, short: 1.5 },
};

// ────────────────────────────────────────────────────────────────────
// State updaters — called from agent execute layer after API actions
// ────────────────────────────────────────────────────────────────────

export async function recordEntry(env: AgentEnvironment): Promise<void> {
  const sql = db();
  await sql`
    UPDATE guardrail_state
       SET last_entry_at = now(),
           open_position_count = open_position_count + 1
     WHERE environment = ${env}
  `;
}

export async function recordClose(env: AgentEnvironment, pnlUsd: number): Promise<void> {
  const sql = db();
  const isLoss = pnlUsd < 0;

  // Update realized PnL + open count + win/loss streak in two queries.
  // (Neon HTTP driver can't compose tagged-template fragments inside a
  // single statement; safer to branch in JS.)
  if (isLoss) {
    await sql`
      UPDATE guardrail_state
         SET daily_realized_pnl    = daily_realized_pnl + ${pnlUsd},
             open_position_count   = GREATEST(open_position_count - 1, 0),
             consecutive_losses    = consecutive_losses + 1
       WHERE environment = ${env}
    `;
  } else {
    await sql`
      UPDATE guardrail_state
         SET daily_realized_pnl    = daily_realized_pnl + ${pnlUsd},
             open_position_count   = GREATEST(open_position_count - 1, 0),
             consecutive_losses    = 0
       WHERE environment = ${env}
    `;
  }

  // Apply cooldown after 2 consecutive losses
  if (isLoss) {
    const limits = LIMITS[env];
    const rows = (await sql`
      SELECT consecutive_losses FROM guardrail_state WHERE environment = ${env}
    `) as unknown as { consecutive_losses: number }[];
    if (rows[0]?.consecutive_losses >= 2) {
      const cooldownHours = limits.cooldownAfterConsecutiveLosses;
      await sql`
        UPDATE guardrail_state
           SET cooldown_until = now() + (${String(cooldownHours)} || ' hours')::interval
         WHERE environment = ${env}
      `;
    }
  }
}
