-- 0005 — strategy attribution for multi-strategy paper trading.
--
-- Up to now every trade came from the HVF strategy. We're adding more
-- (trend-break for momentum/freefall catches, mean-reversion for snap-backs,
-- multi-timeframe HVF confluence for higher-conviction entries). Each
-- trade row records which strategy produced the entry so we can later
-- evaluate PnL/win rate per strategy and promote winning ones to Real.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'hvf';

ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'hvf';

ALTER TABLE trades            DROP CONSTRAINT IF EXISTS trades_strategy_check;
ALTER TABLE agent_decisions   DROP CONSTRAINT IF EXISTS agent_decisions_strategy_check;

-- Allowed values. Add more here as we register new strategies.
ALTER TABLE trades
  ADD CONSTRAINT trades_strategy_check
  CHECK (strategy IN ('hvf', 'trend_break', 'mean_revert', 'hvf_mtf'));

ALTER TABLE agent_decisions
  ADD CONSTRAINT agent_decisions_strategy_check
  CHECK (strategy IN ('hvf', 'trend_break', 'mean_revert', 'hvf_mtf'));

-- Index for per-strategy PnL queries
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy, status, closed_at);
