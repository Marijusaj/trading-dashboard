-- FrancisAgent: Phase 3.1 — Neon schema for autonomous trading agent
-- Run via /api/admin/migrate (POST with admin token) on first deploy.

-- Every agent run records a decision (even no-action "hold" runs).
CREATE TABLE IF NOT EXISTS agent_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts              timestamptz NOT NULL DEFAULT now(),
  environment     text NOT NULL CHECK (environment IN ('real','paper')),
  decision_type   text NOT NULL CHECK (decision_type IN ('open','close','modify','hold','scan_only')),
  asset           text,
  reasoning       text NOT NULL,
  hvf_score       numeric,
  conviction      text CHECK (conviction IN ('high','medium','low')),
  outcome_status  text NOT NULL DEFAULT 'pending'
                    CHECK (outcome_status IN ('executed','skipped_guardrail','failed','pending')),
  guardrail_violation text,
  trade_id        uuid,
  raw_context     jsonb
);
CREATE INDEX IF NOT EXISTS idx_decisions_ts        ON agent_decisions (ts DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_env_ts    ON agent_decisions (environment, ts DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_asset_ts  ON agent_decisions (asset, ts DESC);

-- Trade executions, linked back to the decision that opened them.
CREATE TABLE IF NOT EXISTS trades (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id       uuid REFERENCES agent_decisions(id) ON DELETE SET NULL,
  environment       text NOT NULL CHECK (environment IN ('real','paper')),
  etoro_position_id text,                    -- numeric in API but kept as text for safety
  asset             text NOT NULL,
  instrument_id     bigint NOT NULL,
  side              text NOT NULL CHECK (side IN ('long','short')),
  entry_price       numeric NOT NULL,
  size_usd          numeric NOT NULL,
  units             numeric,
  stop_loss         numeric NOT NULL,
  take_profit       numeric NOT NULL,
  leverage          numeric NOT NULL DEFAULT 1,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  exit_price        numeric,
  pnl_usd           numeric,
  r_multiple        numeric,
  exit_reason       text CHECK (exit_reason IN ('stop','target','manual_close','agent_close','expired')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_trades_status_env  ON trades (status, environment);
CREATE INDEX IF NOT EXISTS idx_trades_opened      ON trades (opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_asset       ON trades (asset);
CREATE INDEX IF NOT EXISTS idx_trades_etoro_pos   ON trades (etoro_position_id);

-- Agent memory: lessons learned, theses, instrument-specific notes, self-reviews.
CREATE TABLE IF NOT EXISTS agent_memory (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts                timestamptz NOT NULL DEFAULT now(),
  category          text NOT NULL CHECK (category IN ('lesson','thesis','instrument_note','self_review')),
  asset             text,
  content           text NOT NULL,
  importance        smallint NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  related_trade_id  uuid REFERENCES trades(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_category_ts ON agent_memory (category, ts DESC);
CREATE INDEX IF NOT EXISTS idx_memory_asset       ON agent_memory (asset, ts DESC);
CREATE INDEX IF NOT EXISTS idx_memory_importance  ON agent_memory (importance DESC, ts DESC);

-- Per-environment guardrail state. Kept as a single row per env to avoid races.
CREATE TABLE IF NOT EXISTS guardrail_state (
  environment           text PRIMARY KEY CHECK (environment IN ('real','paper')),
  daily_realized_pnl    numeric NOT NULL DEFAULT 0,
  daily_reset_at        timestamptz NOT NULL DEFAULT now(),
  consecutive_losses    int     NOT NULL DEFAULT 0,
  cooldown_until        timestamptz,
  last_entry_at         timestamptz,
  open_position_count   int     NOT NULL DEFAULT 0
);

INSERT INTO guardrail_state (environment) VALUES ('real') ON CONFLICT DO NOTHING;
INSERT INTO guardrail_state (environment) VALUES ('paper') ON CONFLICT DO NOTHING;

-- Cached eToro instrument universe — refreshed weekly to keep cron runs fast.
CREATE TABLE IF NOT EXISTS instruments (
  instrument_id   bigint PRIMARY KEY,
  symbol          text NOT NULL,
  name            text,
  asset_class     text,           -- 'crypto', 'commodity', 'equity', 'index', 'fx', 'etf'
  is_tradeable    boolean NOT NULL DEFAULT true,
  metadata        jsonb,
  refreshed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_instruments_symbol ON instruments (symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_class  ON instruments (asset_class);
