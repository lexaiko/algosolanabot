import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { CONFIG } from '../config';
import { Whale, Position, TradeHistoryItem, QueuedWhale } from '../types/index';
import { calculateComprehensiveQuantMetrics, QuantMetricsResult } from '../services/quantMetrics';

const dbPath = path.resolve(process.cwd(), 'tradingbot.db');
export const db = new DatabaseSync(dbPath);

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_wallet (
      id INTEGER PRIMARY KEY,
      balance_sol REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      auto_copy INTEGER DEFAULT 1,
      copy_amount_sol REAL DEFAULT 0.1,
      consecutive_losses INTEGER DEFAULT 0,
      last_trade_at TEXT,
      total_trades_copied INTEGER DEFAULT 0,
      total_pnl_sol REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_name TEXT NOT NULL,
      amount_tokens REAL NOT NULL,
      entry_price_usd REAL NOT NULL,
      entry_sol REAL NOT NULL,
      current_price_usd REAL NOT NULL,
      peak_price_usd REAL NOT NULL,
      pnl_usd REAL DEFAULT 0,
      pnl_pct REAL DEFAULT 0,
      status TEXT DEFAULT 'OPEN',
      is_half_closed INTEGER DEFAULT 0,
      close_reason TEXT,
      whale_source TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS trade_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      amount_tokens REAL NOT NULL,
      price_usd REAL NOT NULL,
      total_sol REAL NOT NULL,
      pnl_sol REAL DEFAULT 0,
      pnl_pct REAL DEFAULT 0,
      reason TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whale_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      archetype TEXT NOT NULL,
      balance_sol REAL DEFAULT 0,
      reference_token TEXT,
      reference_pool TEXT,
      score REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shadow_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      whale_address TEXT NOT NULL,
      whale_label TEXT NOT NULL,
      token_address TEXT NOT NULL,
      entry_price_usd REAL NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT DEFAULT 'WATCHING'
    );

    CREATE TABLE IF NOT EXISTS whale_blacklist (
      address TEXT PRIMARY KEY,
      reason TEXT,
      blacklisted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watchers (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Migrations for existing DB instances
  try { db.exec('ALTER TABLE whales ADD COLUMN consecutive_losses INTEGER DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE whales ADD COLUMN last_trade_at TEXT;'); } catch {}
  try { db.exec('ALTER TABLE whales ADD COLUMN total_trades_copied INTEGER DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE whales ADD COLUMN total_pnl_sol REAL DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE positions ADD COLUMN is_half_closed INTEGER DEFAULT 0;'); } catch {}
  try { db.exec("ALTER TABLE whales ADD COLUMN tier TEXT DEFAULT 'PROBATION';"); } catch {}
  try { db.exec('ALTER TABLE whales ADD COLUMN wins INTEGER DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE whales ADD COLUMN losses INTEGER DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE whales ADD COLUMN win_rate REAL DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE trade_history ADD COLUMN fee_sol REAL DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE trade_history ADD COLUMN net_pnl_sol REAL DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE positions ADD COLUMN target_tp_pct REAL DEFAULT 35.0;'); } catch {}
  try { db.exec('ALTER TABLE positions ADD COLUMN target_sl_pct REAL DEFAULT 20.0;'); } catch {}
  try { db.exec('CREATE TABLE IF NOT EXISTS whale_blacklist (address TEXT PRIMARY KEY, reason TEXT, blacklisted_at TEXT NOT NULL);'); } catch {}
  try { db.exec('CREATE TABLE IF NOT EXISTS watchers (user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, created_at TEXT NOT NULL);'); } catch {}



  // Initialize paper wallet if not exists
  const walletRow = db.prepare('SELECT balance_sol FROM paper_wallet WHERE id = 1').get() as { balance_sol: number } | undefined;
  if (!walletRow) {
    db.prepare('INSERT INTO paper_wallet (id, balance_sol, updated_at) VALUES (1, ?, ?)').run(
      CONFIG.INITIAL_PAPER_BALANCE_SOL,
      new Date().toISOString()
    );
  }

  // Pre-seed real active smart money / whale wallets if none exist
  const countWhales = db.prepare('SELECT COUNT(*) as count FROM whales').get() as { count: number };
  if (countWhales.count === 0) {
    const defaultWhales = [
      { address: '7W7FNDxRS8HGufGxYb5zWEzFWUz4fEPfkD7UA5UktPwy', label: '🐋 Paus Sniper Alpha' },
      { address: '736kh8iv2s3G2zE68NkyYNRaeKbaNHL6mWgHhY2fyu8D', label: '⚡ Solana Smart Momentum' },
      { address: 'D9gTLC9vvVSp9whZspdyiAHQWR4c6apip45wb8uz6EaS', label: '🎯 Raydium Volume Hunter' },
      { address: '8jzmWzQxC273HcZgE1KX4BjnKDUULp7evXRYRfBRFAvA', label: '💎 Pump.fun Gem Finder' },
      { address: 'Fo93iW1TYAaPVoYE5MkgyZT1U8SHPZEs1KoDqpMjTjfn', label: '🔥 Meme Dex Whale' }
    ];

    const insertWhale = db.prepare(`
      INSERT OR IGNORE INTO whales (address, label, is_active, auto_copy, copy_amount_sol, created_at)
      VALUES (?, ?, 1, 1, ?, ?)
    `);

    for (const w of defaultWhales) {
      insertWhale.run(w.address, w.label, CONFIG.DEFAULT_BUY_AMOUNT_SOL, new Date().toISOString());
    }
  }
}

// Wallet Functions
export function getPaperBalance(): number {
  const row = db.prepare('SELECT balance_sol FROM paper_wallet WHERE id = 1').get() as { balance_sol: number } | undefined;
  return row ? row.balance_sol : CONFIG.INITIAL_PAPER_BALANCE_SOL;
}

export function updatePaperBalance(amountDelta: number): number {
  const current = getPaperBalance();
  const newBalance = Math.max(0, current + amountDelta);
  db.prepare('UPDATE paper_wallet SET balance_sol = ?, updated_at = ? WHERE id = 1').run(
    newBalance,
    new Date().toISOString()
  );
  return newBalance;
}

export function resetPaperBalance(amount: number = CONFIG.INITIAL_PAPER_BALANCE_SOL): number {
  db.prepare('UPDATE paper_wallet SET balance_sol = ?, updated_at = ? WHERE id = 1').run(
    amount,
    new Date().toISOString()
  );
  return amount;
}

// Whales Functions
export function getAllWhales(): Whale[] {
  return db.prepare('SELECT * FROM whales ORDER BY id ASC').all() as unknown as Whale[];
}

export function getActiveWhales(): Whale[] {
  return db.prepare('SELECT * FROM whales WHERE is_active = 1').all() as unknown as Whale[];
}

export function addWhale(
  address: string, 
  label: string, 
  copyAmountSol: number = CONFIG.DEFAULT_BUY_AMOUNT_SOL,
  autoCopy: number = 0,
  tier: 'PROBATION' | 'VERIFIED' | 'VIP' = 'PROBATION'
): boolean {
  try {
    db.prepare(`
      INSERT INTO whales (address, label, is_active, auto_copy, copy_amount_sol, tier, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(address.trim(), label.trim(), autoCopy, copyAmountSol, tier, new Date().toISOString());
    return true;
  } catch (err) {
    return false;
  }
}

export function removeWhale(idOrAddress: string | number, reason?: string): boolean {
  try {
    let addressToBlacklist: string | null = null;
    if (reason) {
      if (typeof idOrAddress === 'string' && isNaN(Number(idOrAddress))) {
        addressToBlacklist = idOrAddress.trim();
      } else {
        const row = db.prepare('SELECT address FROM whales WHERE id = ?').get(Number(idOrAddress)) as { address: string } | undefined;
        if (row) addressToBlacklist = row.address;
      }
    }

    if (typeof idOrAddress === 'number' || !isNaN(Number(idOrAddress))) {
      db.prepare('DELETE FROM whales WHERE id = ?').run(Number(idOrAddress));
    } else {
      db.prepare('DELETE FROM whales WHERE address = ?').run(String(idOrAddress).trim());
    }

    if (addressToBlacklist && reason) {
      blacklistWhale(addressToBlacklist, reason);
    }
    return true;
  } catch {
    return false;
  }
}

export function blacklistWhale(address: string, reason: string = 'Eliminasi Kinerja Buruk'): boolean {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO whale_blacklist (address, reason, blacklisted_at)
      VALUES (?, ?, ?)
    `).run(address.trim(), reason.trim(), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

export function isWhaleBlacklisted(address: string): boolean {
  try {
    const row = db.prepare('SELECT address FROM whale_blacklist WHERE address = ?').get(address.trim());
    return !!row;
  } catch {
    return false;
  }
}

export function unblacklistWhale(address: string): boolean {
  try {
    db.prepare('DELETE FROM whale_blacklist WHERE address = ?').run(address.trim());
    return true;
  } catch {
    return false;
  }
}

export function getBlacklistedWhales(): { address: string; reason: string; blacklisted_at: string }[] {
  try {
    return db.prepare('SELECT * FROM whale_blacklist ORDER BY blacklisted_at DESC').all() as any[];
  } catch {
    return [];
  }
}

// Watcher Subscribers Functions (Read-Only Community Mode)
export function addWatcher(userId: number, username?: string, firstName?: string): boolean {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO watchers (user_id, username, first_name, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, username || '', firstName || '', new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

export function removeWatcher(userId: number): boolean {
  try {
    db.prepare('DELETE FROM watchers WHERE user_id = ?').run(userId);
    return true;
  } catch {
    return false;
  }
}

export function isWatcher(userId: number): boolean {
  try {
    const row = db.prepare('SELECT user_id FROM watchers WHERE user_id = ?').get(userId);
    return !!row;
  } catch {
    return false;
  }
}

export function getWatchers(): { user_id: number; username?: string; first_name?: string; created_at: string }[] {
  try {
    return db.prepare('SELECT * FROM watchers ORDER BY created_at ASC').all() as any[];
  } catch {
    return [];
  }
}

export function getWhaleByAddress(address: string): Whale | undefined {
  return db.prepare('SELECT * FROM whales WHERE address = ?').get(address.trim()) as unknown as Whale | undefined;
}

// Whale Queue / Bench Pipeline Functions
export function addToWhaleQueue(candidate: {
  address: string;
  label: string;
  archetype: string;
  balanceSol: number;
  referenceToken?: string;
  referencePool?: string;
  score?: number;
}): boolean {
  try {
    const existingActive = getWhaleByAddress(candidate.address);
    if (existingActive) return false;
    if (isWhaleBlacklisted(candidate.address)) return false;

    db.prepare(`
      INSERT INTO whale_queue (address, label, archetype, balance_sol, reference_token, reference_pool, score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.address.trim(),
      candidate.label.trim(),
      candidate.archetype,
      candidate.balanceSol,
      candidate.referenceToken || '',
      candidate.referencePool || '',
      candidate.score || candidate.balanceSol,
      new Date().toISOString()
    );
    return true;
  } catch {
    return false;
  }
}

export function getWhaleQueue(limit: number = 50): QueuedWhale[] {
  try {
    return db.prepare('SELECT * FROM whale_queue ORDER BY score DESC, balance_sol DESC, id ASC LIMIT ?').all(limit) as unknown as QueuedWhale[];
  } catch {
    return [];
  }
}

export function getQueueWhaleById(id: number): QueuedWhale | undefined {
  try {
    return db.prepare('SELECT * FROM whale_queue WHERE id = ?').get(id) as unknown as QueuedWhale | undefined;
  } catch {
    return undefined;
  }
}

export function removeFromWhaleQueue(idOrAddress: string | number): boolean {
  try {
    if (typeof idOrAddress === 'number' || !isNaN(Number(idOrAddress))) {
      db.prepare('DELETE FROM whale_queue WHERE id = ?').run(Number(idOrAddress));
    } else {
      db.prepare('DELETE FROM whale_queue WHERE address = ?').run(String(idOrAddress).trim());
    }
    return true;
  } catch {
    return false;
  }
}

export function clearWhaleQueue(): number {
  try {
    const info = db.prepare('DELETE FROM whale_queue').run();
    return Number(info.changes || 0);
  } catch {
    return 0;
  }
}

export function popBestQueueWhale(): QueuedWhale | undefined {
  try {
    const best = db.prepare('SELECT * FROM whale_queue ORDER BY score DESC, balance_sol DESC, id ASC LIMIT 1').get() as unknown as QueuedWhale | undefined;
    if (best) {
      db.prepare('DELETE FROM whale_queue WHERE id = ?').run(best.id);
    }
    return best;
  } catch {
    return undefined;
  }
}

export function promoteQueueWhaleToActive(queueId?: number): Whale | undefined {
  try {
    let candidate: QueuedWhale | undefined;
    if (queueId) {
      candidate = getQueueWhaleById(queueId);
      if (candidate) {
        db.prepare('DELETE FROM whale_queue WHERE id = ?').run(candidate.id);
      }
    } else {
      candidate = popBestQueueWhale();
    }

    if (!candidate) return undefined;

    // Insert into active whales with tier 'PROBATION'
    const added = addWhale(
      candidate.address,
      candidate.label,
      CONFIG.DEFAULT_BUY_AMOUNT_SOL,
      0, // Shadow tracking initially
      candidate.balance_sol >= CONFIG.VIP_WHALE_BALANCE_SOL ? 'VIP' : 'PROBATION'
    );

    if (added) {
      return getWhaleByAddress(candidate.address);
    }
    return undefined;
  } catch (err: any) {
    console.error('[DB] Error promoting queue whale to active:', err.message);
    return undefined;
  }
}

export function recordWhaleTrade(
  whaleIdentifier: string, 
  pnlSol: number, 
  isWin: boolean
): { promoted: boolean; demoted: boolean; whale: Whale; winRate: number } | undefined {
  try {
    const whale = db.prepare('SELECT * FROM whales WHERE label = ? OR address = ?').get(whaleIdentifier, whaleIdentifier) as Whale | undefined;
    if (!whale) return undefined;

    const newWins = isWin ? (whale.wins || 0) + 1 : (whale.wins || 0);
    const newLosses = isWin ? 0 : (whale.consecutive_losses || 0) + 1;
    const totalLosses = !isWin ? (whale.losses || 0) + 1 : (whale.losses || 0);
    const newTrades = (whale.total_trades_copied || 0) + 1;
    const newPnlSol = (whale.total_pnl_sol || 0) + pnlSol;
    const winRate = newTrades > 0 ? (newWins / newTrades) * 100 : 0;

    let newTier = whale.tier || 'PROBATION';
    let newAutoCopy = whale.auto_copy;
    let promoted = false;
    let demoted = false;

    // Institutional promotion rule:
    // If whale was in PROBATION and achieves a win, promote to VERIFIED & enable auto_copy!
    if (whale.tier === 'PROBATION' && isWin) {
      newTier = 'VERIFIED';
      newAutoCopy = 1;
      promoted = true;
    } else if (whale.tier !== 'PROBATION' && !isWin && newLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES_DEMOTE) {
      // Strike 2: Demoted to PROBATION (Shadow Bench), zero capital risk
      newTier = 'PROBATION';
      newAutoCopy = 0;
      demoted = true;
    }

    db.prepare(`
      UPDATE whales 
      SET consecutive_losses = ?, wins = ?, losses = ?, win_rate = ?, 
          total_trades_copied = ?, total_pnl_sol = ?, tier = ?, auto_copy = ?, last_trade_at = ?
      WHERE id = ?
    `).run(newLosses, newWins, totalLosses, winRate, newTrades, newPnlSol, newTier, newAutoCopy, new Date().toISOString(), whale.id);

    const updatedWhale = getWhaleByAddress(whale.address)!;
    return { promoted, demoted, whale: updatedWhale, winRate };
  } catch (err: any) {
    console.error('[DB] Error recording whale trade result:', err.message);
    return undefined;
  }
}

export function getWhalesForPruning(
  inactiveHours: number = CONFIG.AUTO_PRUNE_INACTIVE_HOURS, 
  maxLosses: number = CONFIG.MAX_CONSECUTIVE_LOSSES_PRUNE,
  minWinRate: number = CONFIG.MIN_WINRATE_PCT
): Whale[] {
  try {
    const cutoffTime = new Date(Date.now() - inactiveHours * 60 * 60 * 1000).toISOString();
    return db.prepare(`
      SELECT * FROM whales 
      WHERE consecutive_losses >= ? 
         OR (total_trades_copied >= 4 AND win_rate < ?)
         OR (created_at <= ? AND (last_trade_at IS NULL OR last_trade_at <= ?))
    `).all(maxLosses, minWinRate, cutoffTime, cutoffTime) as unknown as Whale[];
  } catch {
    return [];
  }
}

export function promoteWhale(idOrAddress: string | number): boolean {
  try {
    const field = typeof idOrAddress === 'number' || !isNaN(Number(idOrAddress)) ? 'id' : 'address';
    db.prepare(`UPDATE whales SET tier = 'VERIFIED', auto_copy = 1 WHERE ${field} = ?`).run(idOrAddress);
    return true;
  } catch {
    return false;
  }
}

export function demoteWhale(idOrAddress: string | number): boolean {
  try {
    const field = typeof idOrAddress === 'number' || !isNaN(Number(idOrAddress)) ? 'id' : 'address';
    db.prepare(`UPDATE whales SET tier = 'PROBATION', auto_copy = 0 WHERE ${field} = ?`).run(idOrAddress);
    return true;
  } catch {
    return false;
  }
}

export function toggleWhaleStatus(id: number): boolean {
  const whale = db.prepare('SELECT is_active FROM whales WHERE id = ?').get(id) as { is_active: number } | undefined;
  if (!whale) return false;
  const newStatus = whale.is_active === 1 ? 0 : 1;
  db.prepare('UPDATE whales SET is_active = ? WHERE id = ?').run(newStatus, id);
  return true;
}

// Shadow Mode Tracking for Probation Whales
export function addShadowWatch(whaleAddress: string, whaleLabel: string, tokenAddress: string, entryPriceUsd: number) {
  try {
    db.prepare(`
      INSERT INTO shadow_watches (whale_address, whale_label, token_address, entry_price_usd, created_at, status)
      VALUES (?, ?, ?, ?, ?, 'WATCHING')
    `).run(whaleAddress, whaleLabel, tokenAddress, entryPriceUsd, new Date().toISOString());
  } catch {}
}

export function getActiveShadowWatch(whaleAddress: string, tokenAddress: string): { id: number; entry_price_usd: number } | undefined {
  try {
    return db.prepare("SELECT id, entry_price_usd FROM shadow_watches WHERE whale_address = ? AND token_address = ? AND status = 'WATCHING' ORDER BY id DESC LIMIT 1").get(whaleAddress, tokenAddress) as any;
  } catch {
    return undefined;
  }
}

export function closeShadowWatch(id: number) {
  try {
    db.prepare("UPDATE shadow_watches SET status = 'RESOLVED' WHERE id = ?").run(id);
  } catch {}
}

export function closeAllShadowWatchesForWhale(whaleAddress: string) {
  try {
    db.prepare("UPDATE shadow_watches SET status = 'RESOLVED' WHERE whale_address = ? AND status = 'WATCHING'").run(whaleAddress);
  } catch {}
}


// Positions Functions
export function getOpenPositions(): Position[] {
  return db.prepare("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY id DESC").all() as unknown as Position[];
}

export function getPositionById(id: number): Position | undefined {
  return db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as unknown as Position | undefined;
}

export function getOpenPositionByToken(tokenAddress: string): Position | undefined {
  return db.prepare("SELECT * FROM positions WHERE token_address = ? AND status = 'OPEN'").get(tokenAddress) as unknown as Position | undefined;
}

export function createPosition(pos: {
  token_address: string;
  token_symbol: string;
  token_name: string;
  amount_tokens: number;
  entry_price_usd: number;
  entry_sol: number;
  whale_source?: string;
  target_tp_pct?: number;
  target_sl_pct?: number;
}): Position {
  const now = new Date().toISOString();
  const tpPct = pos.target_tp_pct || CONFIG.TAKE_PROFIT_PCT;
  const slPct = pos.target_sl_pct || CONFIG.STOP_LOSS_PCT;
  const buyFee = CONFIG.ESTIMATED_BUY_FEE_SOL;

  const info = db.prepare(`
    INSERT INTO positions (
      token_address, token_symbol, token_name, amount_tokens,
      entry_price_usd, entry_sol, current_price_usd, peak_price_usd,
      pnl_usd, pnl_pct, status, whale_source, target_tp_pct, target_sl_pct, opened_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'OPEN', ?, ?, ?, ?)
  `).run(
    pos.token_address,
    pos.token_symbol,
    pos.token_name,
    pos.amount_tokens,
    pos.entry_price_usd,
    pos.entry_sol,
    pos.entry_price_usd,
    pos.entry_price_usd,
    pos.whale_source || 'MANUAL',
    tpPct,
    slPct,
    now
  );

  const newId = Number(info.lastInsertRowid);
  // Log buy history with fee tracking
  db.prepare(`
    INSERT INTO trade_history (
      position_id, token_address, token_symbol, action,
      amount_tokens, price_usd, total_sol, pnl_sol, pnl_pct, fee_sol, net_pnl_sol, reason, timestamp
    ) VALUES (?, ?, ?, 'BUY', ?, ?, ?, 0, 0, ?, ?, ?, ?)
  `).run(
    newId,
    pos.token_address,
    pos.token_symbol,
    pos.amount_tokens,
    pos.entry_price_usd,
    pos.entry_sol,
    buyFee,
    -buyFee,
    pos.whale_source ? `COPY_BUY (${pos.whale_source})` : 'MANUAL_BUY',
    now
  );

  return getPositionById(newId)!;
}

export function updatePositionPrice(id: number, currentPriceUsd: number): Position | undefined {
  const pos = getPositionById(id);
  if (!pos || pos.status !== 'OPEN') return undefined;

  const peakPriceUsd = Math.max(pos.peak_price_usd, currentPriceUsd);
  const pnlPct = ((currentPriceUsd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
  const currentValueUsd = pos.amount_tokens * currentPriceUsd;
  const entryValueUsd = pos.amount_tokens * pos.entry_price_usd;
  const pnlUsd = currentValueUsd - entryValueUsd;

  db.prepare(`
    UPDATE positions 
    SET current_price_usd = ?, peak_price_usd = ?, pnl_usd = ?, pnl_pct = ?
    WHERE id = ?
  `).run(currentPriceUsd, peakPriceUsd, pnlUsd, pnlPct, id);

  return getPositionById(id);
}

export function halfClosePosition(
  id: number,
  exitPriceUsd: number,
  soldSol: number,
  reason: string
): Position | undefined {
  const pos = getPositionById(id);
  if (!pos || pos.status !== 'OPEN' || pos.is_half_closed === 1) return undefined;

  const now = new Date().toISOString();
  const halfTokens = pos.amount_tokens / 2;
  const remainingTokens = pos.amount_tokens - halfTokens;
  const pnlPct = ((exitPriceUsd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
  const halfEntrySol = pos.entry_sol / 2;
  const pnlSol = soldSol - halfEntrySol;

  const sellFee = CONFIG.ESTIMATED_SELL_FEE_SOL;
  const netPnlSol = pnlSol - sellFee;

  db.prepare(`
    UPDATE positions 
    SET amount_tokens = ?, entry_sol = ?, is_half_closed = 1, current_price_usd = ?
    WHERE id = ?
  `).run(remainingTokens, halfEntrySol, exitPriceUsd, id);

  // Record 50% partial exit to trade_history with net fee tracking
  db.prepare(`
    INSERT INTO trade_history (
      position_id, token_address, token_symbol, action,
      amount_tokens, price_usd, total_sol, pnl_sol, pnl_pct, fee_sol, net_pnl_sol, reason, timestamp
    ) VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    pos.token_address,
    pos.token_symbol,
    halfTokens,
    exitPriceUsd,
    soldSol,
    pnlSol,
    pnlPct,
    sellFee,
    netPnlSol,
    reason,
    now
  );

  return getPositionById(id);
}

export function closePosition(
  id: number, 
  exitPriceUsd: number, 
  exitSol: number, 
  reason: string
): Position | undefined {
  const pos = getPositionById(id);
  if (!pos || pos.status !== 'OPEN') return undefined;

  const now = new Date().toISOString();
  const pnlPct = ((exitPriceUsd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
  const pnlSol = exitSol - pos.entry_sol;
  const sellFee = CONFIG.ESTIMATED_SELL_FEE_SOL;
  const netPnlSol = pnlSol - sellFee;
  const pnlUsd = (pos.amount_tokens * exitPriceUsd) - (pos.amount_tokens * pos.entry_price_usd);

  db.prepare(`
    UPDATE positions 
    SET status = 'CLOSED', current_price_usd = ?, pnl_usd = ?, pnl_pct = ?, close_reason = ?, closed_at = ?
    WHERE id = ?
  `).run(exitPriceUsd, pnlUsd, pnlPct, reason, now, id);

  // Record to trade_history with true net fee accounting
  db.prepare(`
    INSERT INTO trade_history (
      position_id, token_address, token_symbol, action,
      amount_tokens, price_usd, total_sol, pnl_sol, pnl_pct, fee_sol, net_pnl_sol, reason, timestamp
    ) VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    pos.token_address,
    pos.token_symbol,
    pos.amount_tokens,
    exitPriceUsd,
    exitSol,
    pnlSol,
    pnlPct,
    sellFee,
    netPnlSol,
    reason,
    now
  );

  return getPositionById(id);
}

// History & Stats
export function getTradeHistory(limit: number = 10): TradeHistoryItem[] {
  return db.prepare('SELECT * FROM trade_history ORDER BY id DESC LIMIT ?').all(limit) as unknown as TradeHistoryItem[];
}

export function getTradingStats() {
  const closedTrades = db.prepare("SELECT * FROM positions WHERE status = 'CLOSED'").all() as unknown as Position[];
  const totalTrades = closedTrades.length;
  const winTrades = closedTrades.filter(t => t.pnl_pct > 0).length;
  const lossTrades = closedTrades.filter(t => t.pnl_pct <= 0).length;
  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
  const totalPnlUsd = closedTrades.reduce((acc, t) => acc + (t.pnl_usd || 0), 0);

  return {
    totalTrades,
    winTrades,
    lossTrades,
    winRate: winRate.toFixed(1),
    totalPnlUsd: totalPnlUsd.toFixed(2),
    openPositionsCount: getOpenPositions().length,
  };
}

// Circuit Breaker State
let circuitBreakerUntil: number = 0;
let circuitBreakerReason: string = '';

export function isCircuitBreakerActive(): { active: boolean; untilMs: number; reason: string } {
  if (!CONFIG.CIRCUIT_BREAKER_ENABLED) {
    return { active: false, untilMs: 0, reason: '' };
  }
  if (Date.now() < circuitBreakerUntil) {
    return { active: true, untilMs: circuitBreakerUntil, reason: circuitBreakerReason };
  }
  return { active: false, untilMs: 0, reason: '' };
}

export function tripCircuitBreaker(cooldownHours: number, reason: string) {
  if (!CONFIG.CIRCUIT_BREAKER_ENABLED || cooldownHours <= 0) return;
  circuitBreakerUntil = Date.now() + cooldownHours * 60 * 60 * 1000;
  circuitBreakerReason = reason;
}

export function resetCircuitBreaker() {
  circuitBreakerUntil = 0;
  circuitBreakerReason = '';
}

export function getDailyStopLossCount(): number {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT COUNT(*) as count 
      FROM trade_history 
      WHERE action = 'SELL' AND (reason LIKE '%SL%' OR reason LIKE '%STOP_LOSS%') AND timestamp >= ?
    `).get(cutoff) as { count: number } | undefined;
    return row?.count || 0;
  } catch {
    return 0;
  }
}

export function getDailyRealizedPnl(): { 
  totalTrades: number; 
  winTrades: number; 
  lossTrades: number; 
  grossPnlSol: number;
  totalFeesSol: number;
  netPnlSol: number; 
  winRate: string;
  bestTrade?: { symbol: string; pnlPct: number; netPnlSol: number };
  worstTrade?: { symbol: string; pnlPct: number; netPnlSol: number };
} {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT token_symbol, pnl_sol, pnl_pct, fee_sol, net_pnl_sol FROM trade_history 
      WHERE action = 'SELL' AND timestamp >= ?
      ORDER BY pnl_sol DESC
    `).all(cutoff) as Array<{ token_symbol: string; pnl_sol: number; pnl_pct: number; fee_sol: number; net_pnl_sol: number }>;

    // Also get all fees from BUYs in last 24h
    const buyFeesRow = db.prepare(`
      SELECT SUM(fee_sol) as total_buy_fees FROM trade_history
      WHERE action = 'BUY' AND timestamp >= ?
    `).get(cutoff) as { total_buy_fees: number } | undefined;

    const totalBuyFees = buyFeesRow?.total_buy_fees || 0;
    const totalSellFees = rows.reduce((acc, r) => acc + (r.fee_sol || CONFIG.ESTIMATED_SELL_FEE_SOL), 0);
    const totalFeesSol = totalBuyFees + totalSellFees;

    const totalTrades = rows.length;
    const winTrades = rows.filter(r => (r.pnl_pct || 0) > 0).length;
    const lossTrades = rows.filter(r => (r.pnl_pct || 0) <= 0).length;
    const grossPnlSol = rows.reduce((acc, r) => acc + (r.pnl_sol || 0), 0);
    const netPnlSol = grossPnlSol - totalFeesSol;
    const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : '0';

    const bestTrade = rows.length > 0 ? {
      symbol: rows[0].token_symbol,
      pnlPct: rows[0].pnl_pct,
      netPnlSol: (rows[0].net_pnl_sol !== undefined && rows[0].net_pnl_sol !== null && rows[0].net_pnl_sol !== 0)
        ? rows[0].net_pnl_sol
        : (rows[0].pnl_sol - CONFIG.ESTIMATED_SELL_FEE_SOL)
    } : undefined;

    const worstTrade = rows.length > 0 ? {
      symbol: rows[rows.length - 1].token_symbol,
      pnlPct: rows[rows.length - 1].pnl_pct,
      netPnlSol: (rows[rows.length - 1].net_pnl_sol !== undefined && rows[rows.length - 1].net_pnl_sol !== null && rows[rows.length - 1].net_pnl_sol !== 0)
        ? rows[rows.length - 1].net_pnl_sol
        : (rows[rows.length - 1].pnl_sol - CONFIG.ESTIMATED_SELL_FEE_SOL)
    } : undefined;

    return { totalTrades, winTrades, lossTrades, grossPnlSol, totalFeesSol, netPnlSol, winRate, bestTrade, worstTrade };
  } catch {
    return { totalTrades: 0, winTrades: 0, lossTrades: 0, grossPnlSol: 0, totalFeesSol: 0, netPnlSol: 0, winRate: '0' };
  }
}

/**
 * Institutional Rolling Window Alpha Scoring: Evaluates whale performance over the last N days
 * to detect strategy decay or market regime shifts.
 */
export function getWhaleRollingStats(whaleLabel: string, days: number = CONFIG.ROLLING_WINDOW_DAYS): {
  rollingTrades: number;
  rollingWins: number;
  rollingLosses: number;
  rollingWinRate: number;
  rollingPnlSol: number;
} {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT th.pnl_sol, th.pnl_pct FROM trade_history th
      LEFT JOIN positions p ON th.position_id = p.id
      WHERE th.action = 'SELL' 
        AND (p.whale_source = ? OR p.whale_source LIKE ? OR th.reason LIKE ?) 
        AND th.timestamp >= ?
    `).all(whaleLabel, `%${whaleLabel}%`, `%${whaleLabel}%`, cutoff) as Array<{ pnl_sol: number; pnl_pct: number }>;

    const rollingTrades = rows.length;
    const rollingWins = rows.filter(r => (r.pnl_pct || 0) > 0).length;
    const rollingLosses = rows.filter(r => (r.pnl_pct || 0) <= 0).length;
    const rollingWinRate = rollingTrades > 0 ? (rollingWins / rollingTrades) * 100 : 0;
    const rollingPnlSol = rows.reduce((acc, r) => acc + (r.pnl_sol || 0), 0);

    return { rollingTrades, rollingWins, rollingLosses, rollingWinRate, rollingPnlSol };
  } catch {
    return { rollingTrades: 0, rollingWins: 0, rollingLosses: 0, rollingWinRate: 0, rollingPnlSol: 0 };
  }
}

/**
 * Institutional Portfolio Quantitative Audit: Computes live Sharpe Ratio, Sortino Ratio,
 * Profit Factor, and Max Drawdown across the entire historical trade journal.
 */
export function getPortfolioQuantMetrics(): QuantMetricsResult {
  try {
    const rows = db.prepare(`
      SELECT pnl_sol, pnl_pct, fee_sol 
      FROM trade_history 
      WHERE action = 'SELL'
      ORDER BY id ASC
    `).all() as Array<{ pnl_sol: number; pnl_pct: number; fee_sol: number }>;

    const trades = rows.map(r => ({
      pnlSol: r.pnl_sol,
      pnlPct: r.pnl_pct,
      feeSol: r.fee_sol || CONFIG.ESTIMATED_SELL_FEE_SOL
    }));

    return calculateComprehensiveQuantMetrics(trades, CONFIG.INITIAL_PAPER_BALANCE_SOL);
  } catch (err: any) {
    console.error('[DB] Error computing portfolio quant metrics:', err.message);
    return calculateComprehensiveQuantMetrics([], CONFIG.INITIAL_PAPER_BALANCE_SOL);
  }
}

export type TradingStrategyMode = 'HYBRID' | 'WHALE_ONLY' | 'ALGO_ONLY';

export function getSetting(key: string, defaultValue: string): string {
  try {
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as any;
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setSetting(key: string, value: string): void {
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run(key, value);
  } catch (err: any) {
    console.error('[DB] Failed to save setting:', err.message);
  }
}

export function getTradingMode(): TradingStrategyMode {
  return (getSetting('TRADING_MODE', 'HYBRID') as TradingStrategyMode) || 'HYBRID';
}

export function setTradingMode(mode: TradingStrategyMode): void {
  setSetting('TRADING_MODE', mode);
}


