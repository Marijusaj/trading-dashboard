-- 0003 — distinguish strategic vs tactical agent traffic.
--
-- Two agents now share the same DB:
--   - 'strategic'  — every 4h, daily candles, full universe, Opus 4.7
--   - 'tactical'   — every 30m, 15m candles, 5 volatile cryptos, Haiku 4.5
--
-- Both agents share guardrail_state (one daily loss cap protects both),
-- but trades + decisions are tagged with kind for analytics + filtering.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS agent_kind text NOT NULL DEFAULT 'strategic';

ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS agent_kind text NOT NULL DEFAULT 'strategic';

ALTER TABLE trades            DROP CONSTRAINT IF EXISTS trades_agent_kind_check;
ALTER TABLE agent_decisions   DROP CONSTRAINT IF EXISTS agent_decisions_agent_kind_check;

ALTER TABLE trades
  ADD CONSTRAINT trades_agent_kind_check
  CHECK (agent_kind IN ('strategic', 'tactical'));

ALTER TABLE agent_decisions
  ADD CONSTRAINT agent_decisions_agent_kind_check
  CHECK (agent_kind IN ('strategic', 'tactical'));

CREATE INDEX IF NOT EXISTS idx_trades_agent_kind    ON trades (agent_kind);
CREATE INDEX IF NOT EXISTS idx_decisions_agent_kind ON agent_decisions (agent_kind);
