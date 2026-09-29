import dotenv from 'dotenv';
dotenv.config();

/**
 * Parse a numeric env var with a safe positive default.
 * Risk parameters MUST be positive and finite — a negative or non-finite
 * value is dangerous (e.g. negative STOP_LOSS_PCT triggers an instant
 * stop-loss on every position, negative MIN_LIQUIDITY_USD inverts floors).
 * Bad input is clamped to the safe default and logged, never trusted.
 */
function numPos(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[CONFIG] ⚠️ Invalid ${key}=${JSON.stringify(raw)} (must be a positive finite number). ` +
      `Falling back to safe default ${defaultValue}.`
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * Like numPos, but the value must also lie inside [min, max].
 */
function numRange(key: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[CONFIG] ⚠️ Invalid ${key}=${JSON.stringify(raw)} (must be a finite number in [${min}, ${max}]). ` +
      `Falling back to safe default ${defaultValue}.`
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * CRITICAL parameters: an explicitly-set invalid value is a FATAL config
 * error, not a silent fallback. A typo'd safety knob must stop the process
 * loudly (O-08) — never run with a silently-clamped survival parameter.
 * Unset vars still take the safe default.
 */
function numCritical(key: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.error(
      `[CONFIG] 🛑 FATAL: ${key}=${JSON.stringify(raw)} is invalid (must be a finite number in [${min}, ${max}]). ` +
      `Refusing to start with a misconfigured critical risk parameter. Fix your .env and restart.`
    );
    process.exit(1);
  }
  return parsed;
}

/** Admin ID: a non-numeric placeholder must warn LOUDLY, not become 0 silently (O-17). */
function parseAdminId(): number {
  const raw = process.env.TELEGRAM_ADMIN_ID;
  if (raw === undefined || raw === null || raw.trim() === '') {
    console.error(
      '[CONFIG] 🛑 FATAL: TELEGRAM_ADMIN_ID is not set. The bot has ZERO human oversight ' +
      '(no alerts, no /kick). Set your numeric Telegram user ID in .env. ' +
      'Autonomous buying will be disabled fail-closed until this is fixed (O-10).'
    );
    return 0;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[CONFIG] 🛑 FATAL: TELEGRAM_ADMIN_ID=${JSON.stringify(raw)} is not a valid positive integer. ` +
      'Use the numeric user ID (from @userinfobot), not a placeholder. ' +
      'Autonomous buying will be disabled fail-closed until this is fixed (O-10).'
    );
    return 0;
  }
  return parsed;
}

export const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_ADMIN_ID: parseAdminId(),

  HELIUS_API_KEY: (process.env.HELIUS_API_KEY || '').split(',')[0]?.trim() || '',
  HELIUS_API_KEYS: (process.env.HELIUS_API_KEY || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean),
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || ((process.env.HELIUS_API_KEY || '').split(',')[0]?.trim()
    ? `https://mainnet.helius-rpc.com/?api-key=${(process.env.HELIUS_API_KEY || '').split(',')[0].trim()}`
    : 'https://solana-rpc.publicnode.com'),

  PAPER_TRADING: process.env.PAPER_TRADING !== 'false', // Default to true for safety
  INITIAL_PAPER_BALANCE_SOL: numCritical('INITIAL_PAPER_BALANCE_SOL', 1.0, 0.001, 100000),
  DEFAULT_BUY_AMOUNT_SOL: numPos('DEFAULT_BUY_AMOUNT_SOL', 0.05),
  SLIPPAGE_PCT: numPos('SLIPPAGE_PCT', 2.5),

  // Risk Management & Multi-Tier TP (Hedge Fund Quant Asymmetry: R:R >= 3.5:1)
  // NOTE (2026-09-29): the live engine exits 100% via the dynamic ratchet
  // trailing stop (tiers +22/+45/+80/+150, floor net-of-fees). TAKE_PROFIT_PCT /
  // TRAILING_STOP_PCT below are kept for the mirror/backtest modules and the
  // Telegram position display only — they are NOT partial-close knobs.
  TAKE_PROFIT_PCT: numPos('TAKE_PROFIT_PCT', 45.0),
  STOP_LOSS_PCT: numCritical('STOP_LOSS_PCT', 9.5, 0.5, 50), // Strict Institutional hard drawdown ceiling
  TRAILING_STOP_PCT: numPos('TRAILING_STOP_PCT', 12.0),

  // Institutional Portfolio & Execution Controls
  // Circuit breaker is ON by default. Env must explicitly say 'false' to disable.
  // Prevents the bot from repeatedly buying straight into a losing streak.
  CIRCUIT_BREAKER_ENABLED: process.env.CIRCUIT_BREAKER_ENABLED !== 'false',
  CIRCUIT_BREAKER_MAX_DAILY_LOSSES: numCritical('CIRCUIT_BREAKER_MAX_DAILY_LOSSES', 3, 1, 50),
  CIRCUIT_BREAKER_COOLDOWN_HOURS: numPos('CIRCUIT_BREAKER_COOLDOWN_HOURS', 1),
  MAX_PRICE_DRIFT_PCT: numPos('MAX_PRICE_DRIFT_PCT', 6.0), // Anti-Chase / Pucuk Guard: cancel if price moved > 6%
  MIN_LIQUIDITY_USD: numCritical('MIN_LIQUIDITY_USD', 30000.0, 1, 1e12), // Min $30k pool liquidity floor (Anti-Slippage)
  // O-01 (2026-09-29): lowered from $150k to $67.5k. The $150k floor was an
  // arbitrary round number that filtered out most real Solana runners before
  // they qualified; $67.5k keeps the "active market" intent while letting the
  // funnel actually see candidates. Calibrated judgment, not backtested —
  // revisit with data.
  MIN_VOLUME_24H_USD: numPos('MIN_VOLUME_24H_USD', 67500.0),
  MIN_MARKET_CAP_USD: numPos('MIN_MARKET_CAP_USD', 15000.0), // Min $15k market cap
  MAX_OPEN_POSITIONS: numPos('MAX_OPEN_POSITIONS', 15), // Max concurrent active trades
  MAX_HOLD_TIME_HOURS: numCritical('MAX_HOLD_TIME_HOURS', 24, 0.25, 720), // 24h Time-Stop (Zombie Token Reaper)
  MAX_5M_PRICE_CHANGE_PCT: numPos('MAX_5M_PRICE_CHANGE_PCT', 50.0), // Anti-FOMO parabolic candle spike
  NOTIFY_ON_REJECT: process.env.NOTIFY_ON_REJECT !== 'false', // Default to true: ALWAYS send warning/cancellation notifications!

  // Institutional Hedge Fund Survival Phase Filters (Anti-Detik-0 Suicide)
  MIN_TOKEN_AGE_SEC: numPos('MIN_TOKEN_AGE_SEC', 180), // Min 3 mins (Shake out block-0 scammers & instant dev dumps)
  MAX_TOKEN_AGE_HOURS: numPos('MAX_TOKEN_AGE_HOURS', 24), // Max 24 hours (Avoid stale zombie coins)
  BONDING_CURVE_MIN_PCT: numRange('BONDING_CURVE_MIN_PCT', 25.0, 0, 100), // Sweet spot: avoid 0-20% dev-controlled curve
  BONDING_CURVE_MAX_PCT: numRange('BONDING_CURVE_MAX_PCT', 85.0, 0, 100), // Sweet spot: avoid 90-99% migration freeze trap
  MAX_DEV_HOLDING_PCT: numRange('MAX_DEV_HOLDING_PCT', 5.0, 0, 100), // Dev wallet must not hold > 5% supply
  MIN_UNIQUE_HOLDERS: numPos('MIN_UNIQUE_HOLDERS', 45), // Organic wallet buyer dispersion

  // O-21 (2026-09-29): whale-scout / copy-trading config REMOVED. The following
  // keys had ZERO readers anywhere in the codebase and only invited confusion:
  // AUTO_WHALE_DISCOVERY, WHALE_DISCOVERY_INTERVAL_MIN, WHALE_SCOUT_BATCH_SIZE,
  // MAX_ACTIVE_WHALES, MIN_WHALE_BALANCE_SOL, MIN_WHALE_HISTORY_TXS,
  // MIN_WHALE_BUY_SOL, MIN_WHALE_HOLDING_SEC, VIP_BUY_AMOUNT_SOL,
  // COPY_SELL_ENABLED, WHALE_CHECK_INTERVAL_SEC, MAX_CONSECUTIVE_LOSSES.
  // (The whales/whale_queue tables and their db helpers remain as dead schema
  // for a future migration; they are never populated — this project does NOT
  // do wallet-following.)

  // Legacy whale-scoring defaults still referenced as default parameter values
  // by the (currently uncalled) db whale helpers. Validated, kept compiling,
  // flagged for removal together with those helpers.
  VIP_WHALE_BALANCE_SOL: numPos('VIP_WHALE_BALANCE_SOL', 10.0),
  AUTO_PRUNE_INACTIVE_HOURS: numPos('AUTO_PRUNE_INACTIVE_HOURS', 168),
  MAX_CONSECUTIVE_LOSSES_DEMOTE: numPos('MAX_CONSECUTIVE_LOSSES_DEMOTE', 2),
  MAX_CONSECUTIVE_LOSSES_PRUNE: numPos('MAX_CONSECUTIVE_LOSSES_PRUNE', 4),
  MIN_WINRATE_PCT: numRange('MIN_WINRATE_PCT', 40.0, 0, 100),

  // Anti-Rug Filter Criteria
  MIN_RUGCHECK_SCORE: numRange('MIN_RUGCHECK_SCORE', 75, 0, 100),
  REQUIRE_MINT_REVOKED: process.env.REQUIRE_MINT_REVOKED !== 'false',
  REQUIRE_FREEZE_REVOKED: process.env.REQUIRE_FREEZE_REVOKED !== 'false',
  REQUIRE_LP_BURNED: process.env.REQUIRE_LP_BURNED !== 'false',
  MAX_TOP10_HOLDERS_PCT: numRange('MAX_TOP10_HOLDERS_PCT', 50.0, 0, 100),

  // Intervals
  POSITION_CHECK_INTERVAL_SEC: numRange('POSITION_CHECK_INTERVAL_SEC', 2, 1, 300), // High-frequency 2-second tick loop

  // Jito MEV Protection & Anti-Sandwich Shield
  JITO_MEV_ENABLED: process.env.JITO_MEV_ENABLED !== 'false',
  JITO_TIP_LAMPORTS: numPos('JITO_TIP_LAMPORTS', 100000), // 0.0001 SOL tip
  JITO_BLOCK_ENGINE_URL: process.env.JITO_BLOCK_ENGINE_URL || 'https://amsterdam.mainnet.block-engine.jito.wtf',

  // Cabal / Sybil Cluster Shield
  CABAL_SHIELD_ENABLED: process.env.CABAL_SHIELD_ENABLED !== 'false',
  CABAL_MAX_TX_LOOKBACK: numPos('CABAL_MAX_TX_LOOKBACK', 25),

  // God-Tier Quant Engine: Kelly Sizing & Flash-Exit Shield
  KELLY_SIZING_ENABLED: process.env.KELLY_SIZING_ENABLED !== 'false',
  KELLY_FRACTION: numCritical('KELLY_FRACTION', 0.25, 0.01, 1.0), // Quarter-Kelly; >1.0 = overbetting, never allowed
  MAX_LIQUIDITY_DEPTH_PCT: numRange('MAX_LIQUIDITY_DEPTH_PCT', 1.5, 0.01, 100), // Never exceed 1.5% of pool depth
  // Hedge-fund portfolio risk (2026-09-29 overhaul): count limits are not enough
  // for a book where memecoins correlate ~0.7 in selloffs.
  MAX_PORTFOLIO_HEAT_PCT: numCritical('MAX_PORTFOLIO_HEAT_PCT', 0.50, 0.01, 1.0), // Max 50% of equity deployed
  DAILY_MAX_LOSS_PCT: numCritical('DAILY_MAX_LOSS_PCT', 0.08, 0.001, 1.0), // Daily equity kill-switch at -8% realized
  FLASH_EXIT_ENABLED: process.env.FLASH_EXIT_ENABLED !== 'false',
  // [EXITFIX-M2] 2026-09-29: default 50.0 — this knob is now LIVE in production
  // (tradeManager flash-exit reads it). 50.0 preserves the previous hardcoded
  // production behavior: trigger only on >50% drain AND collapse below $12k
  // (with prior liq > $5k), so single-tick liquidity noise can't nuke the book.
  // Design decision: kept strict (not 30) because memecoin pools routinely
  // swing 30-40% on normal whale exits; 30% would whipsaw exits on noise.
  FLASH_EXIT_DROP_PCT: numRange('FLASH_EXIT_DROP_PCT', 50.0, 1, 99), // Emergency exit if pool drops > 50% AND below $12k

  // Real Institutional Alpha: True Net PnL, Rolling Alpha & Narrative Shield
  // Calibrated to live Solana Mainnet metrics (Base 5000 lamports + p75 Priority Fee + Jito Tip Floor)
  ESTIMATED_BUY_FEE_SOL: numPos('ESTIMATED_BUY_FEE_SOL', 0.00035), // Base + Priority (~0.00020) + Jito tip (~0.00010)
  ESTIMATED_SELL_FEE_SOL: numPos('ESTIMATED_SELL_FEE_SOL', 0.00025), // Base + Priority (~0.00015) + Jito tip (~0.00005)
  MAX_POSITIONS_PER_NARRATIVE: numPos('MAX_POSITIONS_PER_NARRATIVE', 2), // Max 2 tokens per narrative/sector
  ROLLING_WINDOW_DAYS: numPos('ROLLING_WINDOW_DAYS', 7), // 7-day alpha decay evaluation
  // [EXITFIX-m5] VOLATILITY_ADAPTIVE_EXITS REMOVED 2026-09-29: dead knob — only the
  // retired legacy backtester read it; production never did.
};
