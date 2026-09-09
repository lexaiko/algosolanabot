export interface Whale {
  id: number;
  address: string;
  label: string;
  is_active: number;
  auto_copy: number;
  tier: 'PROBATION' | 'VERIFIED' | 'VIP';
  copy_amount_sol: number;
  created_at: string;
  consecutive_losses: number;
  wins: number;
  losses: number;
  win_rate: number;
  last_trade_at?: string;
  total_trades_copied: number;
  total_pnl_sol: number;
}

export interface Position {
  id: number;
  token_address: string;
  token_symbol: string;
  token_name: string;
  amount_tokens: number;
  entry_price_usd: number;
  entry_sol: number;
  current_price_usd: number;
  peak_price_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  status: 'OPEN' | 'CLOSED';
  is_half_closed: number; // 0 = full position, 1 = 50% TP executed (free-roll moonbag)
  close_reason?: string;
  whale_source?: string;
  target_tp_pct?: number; // Volatility-adaptive take profit
  target_sl_pct?: number; // Volatility-adaptive stop loss
  opened_at: string;
  closed_at?: string;
}

export interface TradeHistoryItem {
  id: number;
  position_id: number;
  token_address: string;
  token_symbol: string;
  action: 'BUY' | 'SELL';
  amount_tokens: number;
  price_usd: number;
  total_sol: number;
  pnl_sol: number;
  fee_sol?: number;
  net_pnl_sol?: number;
  pnl_pct: number;
  reason: string;
  timestamp: string;
}

export interface RugCheckResult {
  score: number; // 0 - 100, higher is better
  isSafe: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  top10HoldersPct: number;
  risks: string[];
}

export interface TokenMarketData {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceNative: number; // Price in SOL
  liquidityUsd: number;
  fdv: number;
  marketCap: number;
  pairAddress: string;
  dexId: string;
  url: string;
  priceChange24h: number;
  priceChange5m?: number;
  volume24h?: number;
}

export interface QueuedWhale {
  id: number;
  address: string;
  label: string;
  archetype: string;
  balance_sol: number;
  reference_token: string;
  reference_pool: string;
  score: number;
  created_at: string;
}

