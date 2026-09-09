import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_ADMIN_ID: Number(process.env.TELEGRAM_ADMIN_ID) || 0,

  HELIUS_API_KEY: (process.env.HELIUS_API_KEY || '').split(',')[0]?.trim() || '',
  HELIUS_API_KEYS: (process.env.HELIUS_API_KEY || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean),
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || ((process.env.HELIUS_API_KEY || '').split(',')[0]?.trim()
    ? `https://mainnet.helius-rpc.com/?api-key=${(process.env.HELIUS_API_KEY || '').split(',')[0].trim()}`
    : 'https://solana-rpc.publicnode.com'),

  PAPER_TRADING: process.env.PAPER_TRADING !== 'false', // Default to true for safety
  INITIAL_PAPER_BALANCE_SOL: Number(process.env.INITIAL_PAPER_BALANCE_SOL) || 10.0,
  DEFAULT_BUY_AMOUNT_SOL: Number(process.env.DEFAULT_BUY_AMOUNT_SOL) || 0.12,
  VIP_BUY_AMOUNT_SOL: Number(process.env.VIP_BUY_AMOUNT_SOL) || 0.20, // Tier-weighted sizing for VIP whales
  SLIPPAGE_PCT: Number(process.env.SLIPPAGE_PCT) || 2.5,

  // Risk Management & Multi-Tier TP
  TAKE_PROFIT_PCT: Number(process.env.TAKE_PROFIT_PCT) || 42.0, // Stage 1 TP: Sell 50% (Pro Asymmetric Payoff)
  STOP_LOSS_PCT: Number(process.env.STOP_LOSS_PCT) || 14.0, // Institutional 14% max drawdown ceiling
  TRAILING_STOP_PCT: Number(process.env.TRAILING_STOP_PCT) || 18.0, // Moonbag breathing room protection (Pro Wide Trailing)

  // Institutional Portfolio & Execution Controls
  COPY_SELL_ENABLED: process.env.COPY_SELL_ENABLED !== 'false', // Auto-dump when whale dumps
  CIRCUIT_BREAKER_ENABLED: process.env.CIRCUIT_BREAKER_ENABLED === 'true', // Dinonaktifkan sementara per instruksi user (tanpa batasan jam cooldown)
  CIRCUIT_BREAKER_MAX_DAILY_LOSSES: Number(process.env.CIRCUIT_BREAKER_MAX_DAILY_LOSSES) || 999, // Tanpa batasan limit stop-loss
  CIRCUIT_BREAKER_COOLDOWN_HOURS: Number(process.env.CIRCUIT_BREAKER_COOLDOWN_HOURS) || 0, // 0 jam cooldown
  MAX_PRICE_DRIFT_PCT: Number(process.env.MAX_PRICE_DRIFT_PCT) || 6.0, // Anti-Chase / Pucuk Guard: cancel if price moved > 6%
  MIN_LIQUIDITY_USD: Number(process.env.MIN_LIQUIDITY_USD) || 25000.0, // Min $25k pool liquidity floor (Anti-Slippage)
  MIN_VOLUME_24H_USD: Number(process.env.MIN_VOLUME_24H_USD) || 150000.0, // Min $150k 24h volume floor (Active Market)
  MIN_MARKET_CAP_USD: Number(process.env.MIN_MARKET_CAP_USD) || 15000.0, // Min $15k market cap
  MAX_OPEN_POSITIONS: Number(process.env.MAX_OPEN_POSITIONS) || 15, // Max concurrent active trades (allows up to 15 concurrent positions for backtesting & broad diversification)
  MAX_HOLD_TIME_HOURS: Number(process.env.MAX_HOLD_TIME_HOURS) || 24, // 24h Time-Stop (Zombie Token Reaper)
  MAX_5M_PRICE_CHANGE_PCT: Number(process.env.MAX_5M_PRICE_CHANGE_PCT) || 50.0, // Anti-FOMO parabolic candle spike (allows up to +50% explosive momentum)
  NOTIFY_ON_REJECT: process.env.NOTIFY_ON_REJECT !== 'false', // Default to true: ALWAYS send warning/cancellation notifications!

  // Institutional Hedge Fund Survival Phase Filters (Anti-Detik-0 Suicide)
  MIN_TOKEN_AGE_SEC: Number(process.env.MIN_TOKEN_AGE_SEC) || 180, // Min 3 mins (Shake out block-0 scammers & instant dev dumps)
  MAX_TOKEN_AGE_HOURS: Number(process.env.MAX_TOKEN_AGE_HOURS) || 24, // Max 24 hours (Avoid stale zombie coins)
  BONDING_CURVE_MIN_PCT: Number(process.env.BONDING_CURVE_MIN_PCT) || 25.0, // Sweet spot: avoid 0-20% dev-controlled curve
  BONDING_CURVE_MAX_PCT: Number(process.env.BONDING_CURVE_MAX_PCT) || 85.0, // Sweet spot: avoid 90-99% migration freeze trap
  MAX_DEV_HOLDING_PCT: Number(process.env.MAX_DEV_HOLDING_PCT) || 5.0, // Dev wallet must not hold > 5% supply
  MIN_UNIQUE_HOLDERS: Number(process.env.MIN_UNIQUE_HOLDERS) || 45, // Organic wallet buyer dispersion

  // Autonomous Whale Scout & Institutional Screening
  AUTO_WHALE_DISCOVERY: process.env.AUTO_WHALE_DISCOVERY !== 'false',
  WHALE_DISCOVERY_INTERVAL_MIN: Number(process.env.WHALE_DISCOVERY_INTERVAL_MIN) || 30,
  WHALE_SCOUT_BATCH_SIZE: Number(process.env.WHALE_SCOUT_BATCH_SIZE) || 4, // Scan & recruit up to 4 whales per scout run
  MAX_ACTIVE_WHALES: Number(process.env.MAX_ACTIVE_WHALES) || 15,
  MIN_WHALE_BALANCE_SOL: Number(process.env.MIN_WHALE_BALANCE_SOL) || 1.5, // Minimum 1.5 SOL on-chain balance
  VIP_WHALE_BALANCE_SOL: Number(process.env.VIP_WHALE_BALANCE_SOL) || 10.0, // High-Net-Worth VIP whale threshold
  MIN_WHALE_HISTORY_TXS: Number(process.env.MIN_WHALE_HISTORY_TXS) || 10, // Minimum 10 past txs (anti-burner)
  MIN_WHALE_BUY_SOL: Number(process.env.MIN_WHALE_BUY_SOL) || 0.2, // Minimum 0.2 SOL per buy
  MIN_WHALE_HOLDING_SEC: Number(process.env.MIN_WHALE_HOLDING_SEC) || 90, // Reject MEV bots flipping in < 90s
  AUTO_PRUNE_INACTIVE_HOURS: Number(process.env.AUTO_PRUNE_INACTIVE_HOURS) || 168, // 7 days (respect patience)
  MAX_CONSECUTIVE_LOSSES: Number(process.env.MAX_CONSECUTIVE_LOSSES) || 4, // Hard Cut from DB if 4 SL in a row
  MAX_CONSECUTIVE_LOSSES_DEMOTE: Number(process.env.MAX_CONSECUTIVE_LOSSES_DEMOTE) || 2, // 2-Strike Rule: Demoted to Shadow Probation (auto_copy = 0)
  MAX_CONSECUTIVE_LOSSES_PRUNE: Number(process.env.MAX_CONSECUTIVE_LOSSES_PRUNE) || 4, // Hard Cut: Permanently eliminated from DB
  MIN_WINRATE_PCT: Number(process.env.MIN_WINRATE_PCT) || 40.0, // Fired if winrate < 40% after >= 4 trades

  // Anti-Rug Filter Criteria
  MIN_RUGCHECK_SCORE: Number(process.env.MIN_RUGCHECK_SCORE) || 75,
  REQUIRE_MINT_REVOKED: process.env.REQUIRE_MINT_REVOKED !== 'false',
  REQUIRE_FREEZE_REVOKED: process.env.REQUIRE_FREEZE_REVOKED !== 'false',
  REQUIRE_LP_BURNED: process.env.REQUIRE_LP_BURNED !== 'false',
  MAX_TOP10_HOLDERS_PCT: Number(process.env.MAX_TOP10_HOLDERS_PCT) || 50.0,

  // Intervals
  POSITION_CHECK_INTERVAL_SEC: Number(process.env.POSITION_CHECK_INTERVAL_SEC) || 2, // High-frequency 2-second tick loop
  WHALE_CHECK_INTERVAL_SEC: Number(process.env.WHALE_CHECK_INTERVAL_SEC) || 15,

  // Jito MEV Protection & Anti-Sandwich Shield
  JITO_MEV_ENABLED: process.env.JITO_MEV_ENABLED !== 'false',
  JITO_TIP_LAMPORTS: Number(process.env.JITO_TIP_LAMPORTS) || 100000, // 0.0001 SOL tip
  JITO_BLOCK_ENGINE_URL: process.env.JITO_BLOCK_ENGINE_URL || 'https://amsterdam.mainnet.block-engine.jito.wtf',

  // Cabal / Sybil Cluster Shield
  CABAL_SHIELD_ENABLED: process.env.CABAL_SHIELD_ENABLED !== 'false',
  CABAL_MAX_TX_LOOKBACK: Number(process.env.CABAL_MAX_TX_LOOKBACK) || 25,

  // God-Tier Quant Engine: Kelly Sizing & Flash-Exit Shield
  KELLY_SIZING_ENABLED: process.env.KELLY_SIZING_ENABLED !== 'false',
  KELLY_FRACTION: Number(process.env.KELLY_FRACTION) || 0.25, // Quarter-Kelly (mathematical optimum)
  MAX_LIQUIDITY_DEPTH_PCT: Number(process.env.MAX_LIQUIDITY_DEPTH_PCT) || 1.5, // Never exceed 1.5% of pool depth
  FLASH_EXIT_ENABLED: process.env.FLASH_EXIT_ENABLED !== 'false',
  FLASH_EXIT_DROP_PCT: Number(process.env.FLASH_EXIT_DROP_PCT) || 30.0, // Emergency exit if pool drops > 30%

  // Real Institutional Alpha: True Net PnL, Rolling Alpha & Narrative Shield
  ESTIMATED_BUY_FEE_SOL: Number(process.env.ESTIMATED_BUY_FEE_SOL) || 0.0010, // Base + Priority + Jito tip + Rent
  ESTIMATED_SELL_FEE_SOL: Number(process.env.ESTIMATED_SELL_FEE_SOL) || 0.0006, // Base + Priority + Jito tip
  MAX_POSITIONS_PER_NARRATIVE: Number(process.env.MAX_POSITIONS_PER_NARRATIVE) || 2, // Max 2 tokens per narrative/sector
  ROLLING_WINDOW_DAYS: Number(process.env.ROLLING_WINDOW_DAYS) || 7, // 7-day alpha decay evaluation
  VOLATILITY_ADAPTIVE_EXITS: process.env.VOLATILITY_ADAPTIVE_EXITS !== 'false',
};
