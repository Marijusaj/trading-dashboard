// Guardrails: enforced limits that no agent decision can bypass.
// All trade execution flows through checkGuardrails() before hitting eToro.
//
// These are intentionally CONSERVATIVE and live in code (not prompt) so
// the LLM cannot talk itself out of them.
import { db } from "@/lib/neon";
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
    maxPositionSizeUsd: 50,
    maxConcurrentPositions: 3,
    maxDailyLossUsd: 30,             // 6% of $500 starting capital
    minMinutesBetweenEntries: 240,   // 4h
    minRewardRiskRatio: 1.5,
    maxLeverage: 1,
    cooldownAfterConsecutiveLosses: 24,
  },
  paper: {
    maxPositionSizeUsd: 5_000,
    maxConcurrentPositions: 8,
    maxDailyLossUsd: 8_400,          // 6% of $140k
    minMinutesBetweenEntries: 240,
    minRewardRiskRatio: 1.5,
    maxLeverage: 2,
    cooldownAfterConsecutiveLosses: 12,
  },
};

export interface ProposedTrade {
  environment: AgentEnvironment;
  asset: string;
  sizeUsd: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  entryPrice: number;
  direction: "long" | "short";
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

  // 1. Position size
  if (trade.sizeUsd > limits.maxPositionSizeUsd) {
    return {
      allowed: false,
      violation: "max_position_size",
      details: { proposed: trade.sizeUsd, max: limits.maxPositionSizeUsd },
    };
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

  return { allowed: true, violation: null, details: { rewardRiskRatio: Number(rr.toFixed(2)) } };
}

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
