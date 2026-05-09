-- 0004 — multi-venue support: eToro + Binance.
--
-- Until now every trade went through eToro (env=paper|real). The user
-- holds USDC on Binance and wants the agent to place spot-long bets
-- there too, on the same HVF setups.
--
-- Two changes:
--
-- 1. New `venue` column on trades + agent_decisions (default 'etoro')
--    so existing rows are tagged correctly without backfill.
--
-- 2. Loosen the env CHECK to allow 'binance' as a third value. Binance
--    doesn't have a paper mode — env='binance' means live USDC spot.
--    The eToro paper/real distinction stays meaningful only when
--    venue='etoro'.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS venue text NOT NULL DEFAULT 'etoro';

ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS venue text NOT NULL DEFAULT 'etoro';

ALTER TABLE trades            DROP CONSTRAINT IF EXISTS trades_venue_check;
ALTER TABLE agent_decisions   DROP CONSTRAINT IF EXISTS agent_decisions_venue_check;

ALTER TABLE trades
  ADD CONSTRAINT trades_venue_check
  CHECK (venue IN ('etoro', 'binance'));

ALTER TABLE agent_decisions
  ADD CONSTRAINT agent_decisions_venue_check
  CHECK (venue IN ('etoro', 'binance'));

-- env can now also be 'binance'. Drop the old constraint if it existed.
ALTER TABLE trades            DROP CONSTRAINT IF EXISTS trades_environment_check;
ALTER TABLE agent_decisions   DROP CONSTRAINT IF EXISTS agent_decisions_environment_check;
ALTER TABLE guardrail_state   DROP CONSTRAINT IF EXISTS guardrail_state_environment_check;

ALTER TABLE trades
  ADD CONSTRAINT trades_environment_check
  CHECK (environment IN ('paper', 'real', 'binance'));

ALTER TABLE agent_decisions
  ADD CONSTRAINT agent_decisions_environment_check
  CHECK (environment IN ('paper', 'real', 'binance'));

ALTER TABLE guardrail_state
  ADD CONSTRAINT guardrail_state_environment_check
  CHECK (environment IN ('paper', 'real', 'binance'));

-- Seed a guardrail_state row for binance (matches the pattern used
-- for paper/real). Daily counters all start at zero.
INSERT INTO guardrail_state (
  environment, daily_realized_pnl, daily_reset_at, consecutive_losses,
  cooldown_until, last_entry_at, open_position_count
) VALUES (
  'binance', 0, now(), 0, NULL, NULL, 0
)
ON CONFLICT (environment) DO NOTHING;
