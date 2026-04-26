-- 0002 — track eToro order_id alongside position_id so the reconciler
-- can poll order status and resolve pending entries (executed,
-- rejected, cancelled, expired) on subsequent agent runs.

ALTER TABLE trades ADD COLUMN IF NOT EXISTS etoro_order_id text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_trades_order_id ON trades (etoro_order_id);
CREATE INDEX IF NOT EXISTS idx_trades_pending  ON trades (status, etoro_position_id) WHERE status = 'open';

-- Allow trade.status='abandoned' for entries we can't reconcile
-- (legacy rows with no order_id, or 24h+ pending without resolution).
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_status_check;
ALTER TABLE trades ADD CONSTRAINT trades_status_check
  CHECK (status IN ('open','closed','cancelled','abandoned'));
