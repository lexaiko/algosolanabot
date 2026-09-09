-- Migration: 001_initial_schema.sql
-- Institutional PostgreSQL Persistence Schema for Systematic Solana Trading

CREATE TABLE IF NOT EXISTS tokens (
  id BIGSERIAL PRIMARY KEY,
  address VARCHAR(64) UNIQUE NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  decimals INT NOT NULL DEFAULT 9,
  is_pump_fun BOOLEAN NOT NULL DEFAULT FALSE,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pools (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT REFERENCES tokens(id) ON DELETE CASCADE,
  pool_address VARCHAR(64) UNIQUE NOT NULL,
  dex_id VARCHAR(32) NOT NULL,
  quote_token VARCHAR(64) NOT NULL DEFAULT 'So11111111111111111111111111111111111111112',
  initial_liquidity_usd NUMERIC(16, 4),
  initial_price_usd NUMERIC(24, 12),
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_events (
  id BIGSERIAL PRIMARY KEY,
  event_id VARCHAR(64) UNIQUE NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  pool_address VARCHAR(64) NOT NULL,
  source VARCHAR(32) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  slot BIGINT,
  price_usd NUMERIC(24, 12) NOT NULL,
  price_native NUMERIC(24, 12),
  volume_usd NUMERIC(16, 4),
  liquidity_usd NUMERIC(16, 4),
  maker_address VARCHAR(64),
  is_buy BOOLEAN,
  data_quality VARCHAR(16) NOT NULL DEFAULT 'VALID',
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_market_events_token_time ON market_events(token_address, ingested_at DESC);

CREATE TABLE IF NOT EXISTS features_snapshot (
  id BIGSERIAL PRIMARY KEY,
  token_address VARCHAR(64) NOT NULL,
  timeframe VARCHAR(16) NOT NULL DEFAULT '5m',
  return_1m NUMERIC(8, 4),
  return_5m NUMERIC(8, 4),
  return_15m NUMERIC(8, 4),
  realized_vol NUMERIC(8, 4),
  volume_accel NUMERIC(8, 4),
  buy_sell_ratio NUMERIC(8, 4),
  liquidity_depth_usd NUMERIC(16, 4),
  cabal_risk_score NUMERIC(8, 4),
  regime VARCHAR(32) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decision_journal (
  id BIGSERIAL PRIMARY KEY,
  decision_id VARCHAR(64) UNIQUE NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  token_symbol VARCHAR(32) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  composite_score INT NOT NULL,
  strategy_name VARCHAR(64) NOT NULL,
  regime VARCHAR(32) NOT NULL,
  allocated_sol NUMERIC(12, 6),
  rejection_reasons JSONB,
  feature_vector JSONB NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  counterfactual_return_15m NUMERIC(8, 4),
  counterfactual_return_1h NUMERIC(8, 4),
  counterfactual_return_4h NUMERIC(8, 4)
);
CREATE INDEX IF NOT EXISTS idx_decision_journal_token ON decision_journal(token_address);
CREATE INDEX IF NOT EXISTS idx_decision_journal_decision ON decision_journal(decision);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_id VARCHAR(64) UNIQUE NOT NULL,
  decision_id VARCHAR(64),
  token_address VARCHAR(64) NOT NULL,
  token_symbol VARCHAR(32) NOT NULL,
  side VARCHAR(8) NOT NULL,
  requested_sol NUMERIC(12, 6) NOT NULL,
  executed_sol NUMERIC(12, 6),
  expected_price_usd NUMERIC(24, 12) NOT NULL,
  executed_price_usd NUMERIC(24, 12),
  slippage_pct NUMERIC(6, 3),
  priority_fee_sol NUMERIC(10, 8),
  jito_tip_sol NUMERIC(10, 8),
  status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
  tx_signature VARCHAR(128),
  error_message TEXT,
  slot_confirmed BIGINT,
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
  id BIGSERIAL PRIMARY KEY,
  token_address VARCHAR(64) NOT NULL,
  token_symbol VARCHAR(32) NOT NULL,
  token_name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  entry_price_usd NUMERIC(24, 12) NOT NULL,
  entry_sol NUMERIC(12, 6) NOT NULL,
  amount_tokens NUMERIC(30, 9) NOT NULL,
  current_price_usd NUMERIC(24, 12) NOT NULL,
  peak_price_usd NUMERIC(24, 12) NOT NULL,
  pnl_usd NUMERIC(16, 4) DEFAULT 0,
  pnl_pct NUMERIC(8, 4) DEFAULT 0,
  is_half_closed BOOLEAN NOT NULL DEFAULT FALSE,
  target_tp_pct NUMERIC(6, 2) NOT NULL,
  target_sl_pct NUMERIC(6, 2) NOT NULL,
  strategy_name VARCHAR(64) NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  close_reason TEXT
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id BIGSERIAL PRIMARY KEY,
  strategy_name VARCHAR(64) NOT NULL,
  version_tag VARCHAR(32) NOT NULL,
  parameters JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  walk_forward_sharpe NUMERIC(6, 3),
  walk_forward_profit_factor NUMERIC(6, 3),
  walk_forward_expectancy NUMERIC(6, 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
