-- Migration: 001_sqlite_schema.sql
-- Production SQLite Schema for Institutional Systematic Solana Trading
-- Ultra-low latency, embedded in-process database with WAL concurrency

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT UNIQUE NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 9,
  is_pump_fun INTEGER NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER,
  pool_address TEXT UNIQUE NOT NULL,
  dex_id TEXT NOT NULL,
  quote_token TEXT NOT NULL DEFAULT 'So11111111111111111111111111111111111111112',
  initial_liquidity_usd REAL,
  initial_price_usd REAL,
  discovered_at TEXT NOT NULL,
  FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS market_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  token_address TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  slot INTEGER,
  price_usd REAL NOT NULL,
  price_native REAL,
  volume_usd REAL,
  liquidity_usd REAL,
  maker_address TEXT,
  is_buy INTEGER DEFAULT 1,
  data_quality TEXT NOT NULL DEFAULT 'VALID',
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_events_token ON market_events(token_address, ingested_at DESC);

CREATE TABLE IF NOT EXISTS features_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '5m',
  return_1m REAL,
  return_5m REAL,
  return_15m REAL,
  realized_vol REAL,
  volume_accel REAL,
  buy_sell_ratio REAL,
  liquidity_depth_usd REAL,
  cabal_risk_score REAL,
  regime TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT UNIQUE NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  decision TEXT NOT NULL,
  composite_score INTEGER NOT NULL,
  strategy_name TEXT NOT NULL,
  regime TEXT NOT NULL,
  allocated_sol REAL,
  rejection_reasons TEXT,
  feature_vector TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  counterfactual_return_15m REAL,
  counterfactual_return_1h REAL,
  counterfactual_return_4h REAL
);
CREATE INDEX IF NOT EXISTS idx_decision_journal_token ON decision_journal(token_address);
CREATE INDEX IF NOT EXISTS idx_decision_journal_decision ON decision_journal(decision);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  decision_id TEXT,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  requested_sol REAL NOT NULL,
  executed_sol REAL,
  expected_price_usd REAL NOT NULL,
  executed_price_usd REAL,
  slippage_pct REAL,
  priority_fee_sol REAL,
  jito_tip_sol REAL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  tx_signature TEXT,
  error_message TEXT,
  slot_confirmed INTEGER,
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  token_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  entry_price_usd REAL NOT NULL,
  entry_sol REAL NOT NULL,
  amount_tokens REAL NOT NULL,
  current_price_usd REAL NOT NULL,
  peak_price_usd REAL NOT NULL,
  pnl_usd REAL DEFAULT 0,
  pnl_pct REAL DEFAULT 0,
  is_half_closed INTEGER NOT NULL DEFAULT 0,
  target_tp_pct REAL NOT NULL,
  target_sl_pct REAL NOT NULL,
  strategy_name TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT
);
