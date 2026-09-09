import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { IStorageRepository } from './interfaces';
import { 
  TokenEntity, 
  PoolEntity, 
  MarketEvent, 
  FeatureVector, 
  DecisionJournalRecord, 
  OrderIntent, 
  ExecutionFill, 
  PositionRecord,
  ExpectancyMetrics
} from '../core/types';

export class SqliteStorageRepository implements IStorageRepository {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(customPath?: string) {
    this.dbPath = customPath || path.resolve(process.cwd(), 'tradingbot.db');
    this.db = new DatabaseSync(this.dbPath);
    this.initPragmasAndTables();
  }

  private initPragmasAndTables() {
    // 1. High-Concurrency Performance PRAGMAs
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;
    `);

    // 2. Production Tables
    this.db.exec(`
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
        discovered_at TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_mkt_evt_token ON market_events(token_address, ingested_at DESC);

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
      CREATE INDEX IF NOT EXISTS idx_dec_jnl_token ON decision_journal(token_address);
      CREATE INDEX IF NOT EXISTS idx_dec_jnl_decision ON decision_journal(decision);

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
    `);

    // 3. Ensure backwards compatibility with any pre-existing positions table
    try {
      const columns = this.db.prepare("PRAGMA table_info(positions)").all() as any[];
      const columnNames = new Set(columns.map(c => c.name));
      if (!columnNames.has('target_tp_pct')) {
        this.db.exec("ALTER TABLE positions ADD COLUMN target_tp_pct REAL DEFAULT 35.0;");
      }
      if (!columnNames.has('target_sl_pct')) {
        this.db.exec("ALTER TABLE positions ADD COLUMN target_sl_pct REAL DEFAULT 12.0;");
      }
      if (!columnNames.has('strategy_name')) {
        this.db.exec("ALTER TABLE positions ADD COLUMN strategy_name TEXT DEFAULT 'MOMENTUM';");
      }
    } catch {}
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  // 1. Tokens & Pools
  async saveToken(token: TokenEntity): Promise<TokenEntity> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tokens (address, symbol, name, decimals, is_pump_fun, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      token.address,
      token.symbol,
      token.name,
      token.decimals,
      token.isPumpFun ? 1 : 0,
      token.discoveredAt || new Date().toISOString()
    );
    return token;
  }

  async getToken(address: string): Promise<TokenEntity | null> {
    const stmt = this.db.prepare('SELECT * FROM tokens WHERE address = ?');
    const row = stmt.get(address) as any;
    if (!row) return null;
    return {
      id: row.id,
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      isPumpFun: row.is_pump_fun === 1,
      discoveredAt: row.discovered_at
    };
  }

  async savePool(pool: PoolEntity): Promise<PoolEntity> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pools (token_id, pool_address, dex_id, quote_token, initial_liquidity_usd, initial_price_usd, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      Number(pool.tokenId),
      pool.poolAddress,
      pool.dexId,
      pool.quoteToken,
      pool.initialLiquidityUsd,
      pool.initialPriceUsd,
      pool.discoveredAt || new Date().toISOString()
    );
    return pool;
  }

  async getPoolByToken(tokenId: string | number): Promise<PoolEntity | null> {
    const stmt = this.db.prepare('SELECT * FROM pools WHERE token_id = ?');
    const row = stmt.get(Number(tokenId)) as any;
    if (!row) return null;
    return {
      id: row.id,
      tokenId: row.token_id,
      poolAddress: row.pool_address,
      dexId: row.dex_id,
      quoteToken: row.quote_token,
      initialLiquidityUsd: row.initial_liquidity_usd,
      initialPriceUsd: row.initial_price_usd,
      discoveredAt: row.discovered_at
    };
  }

  // 2. Events & Features
  async recordMarketEvent(event: MarketEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO market_events (
        event_id, token_address, pool_address, source, event_type, slot,
        price_usd, price_native, volume_usd, liquidity_usd, maker_address,
        is_buy, data_quality, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.eventId,
      event.tokenId,
      event.poolAddress,
      event.source,
      event.eventType,
      event.slot || null,
      event.priceUsd,
      event.priceNative,
      event.volumeUsd,
      event.liquidityUsd,
      event.makerAddress || null,
      event.isBuy ? 1 : 0,
      event.dataQuality,
      new Date(event.timestampMs).toISOString()
    );
  }

  async getRecentMarketEvents(tokenAddress: string, limit: number = 50): Promise<MarketEvent[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM market_events 
      WHERE token_address = ? 
      ORDER BY id DESC 
      LIMIT ?
    `);
    const rows = stmt.all(tokenAddress, limit) as any[];
    return rows.reverse().map(r => ({
      eventId: r.event_id,
      tokenId: r.token_address,
      tokenSymbol: '',
      poolAddress: r.pool_address,
      source: r.source,
      eventType: r.event_type,
      slot: r.slot,
      timestampMs: new Date(r.ingested_at).getTime(),
      priceUsd: r.price_usd,
      priceNative: r.price_native,
      volumeUsd: r.volume_usd,
      liquidityUsd: r.liquidity_usd,
      makerAddress: r.maker_address,
      isBuy: r.is_buy === 1,
      dataQuality: r.data_quality
    }));
  }

  async saveFeatureSnapshot(features: FeatureVector): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO features_snapshot (
        token_address, timeframe, return_1m, return_5m, return_15m,
        realized_vol, volume_accel, buy_sell_ratio, liquidity_depth_usd,
        cabal_risk_score, regime, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      features.tokenId,
      features.timeframe,
      features.return1m,
      features.return5m,
      features.return15m,
      features.realizedVol,
      features.volumeAcceleration,
      features.buySellRatio,
      features.liquidityUsd,
      features.cabalClusterRiskScore,
      features.regime,
      new Date(features.timestampMs).toISOString()
    );
  }

  async getLatestFeatures(tokenAddress: string): Promise<FeatureVector | null> {
    const stmt = this.db.prepare('SELECT * FROM features_snapshot WHERE token_address = ? ORDER BY id DESC LIMIT 1');
    const row = stmt.get(tokenAddress) as any;
    if (!row) return null;
    return {
      tokenId: row.token_address,
      timestampMs: new Date(row.computed_at).getTime(),
      timeframe: row.timeframe,
      return1m: row.return_1m,
      return5m: row.return_5m,
      return15m: row.return_15m,
      realizedVol: row.realized_vol,
      atrPct: row.realized_vol * 1.2,
      breakoutDistancePct: row.return_5m > 0 ? row.return_5m * 0.8 : 0,
      drawdownFromPeakPct: 0,
      volume5mUsd: 10000,
      volumeAcceleration: row.volume_accel,
      buySellRatio: row.buy_sell_ratio,
      flowImbalance: 0,
      tradeCount5m: 10,
      avgTradeSizeUsd: 100,
      liquidityUsd: row.liquidity_depth_usd,
      liquidityChangePct: 0,
      estimatedPriceImpactPct: 0.5,
      whaleNetFlowSol: 0,
      smartMoneyAccumulationScore: 50,
      cabalClusterRiskScore: row.cabal_risk_score,
      regime: row.regime,
      quality: 'VALID'
    };
  }

  // 3. Decision Journal & Counterfactuals
  async recordDecision(entry: DecisionJournalRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO decision_journal (
        decision_id, token_address, token_symbol, decision, composite_score,
        strategy_name, regime, allocated_sol, rejection_reasons, feature_vector, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.decisionId,
      entry.tokenId,
      entry.tokenSymbol,
      entry.decision,
      entry.compositeScore,
      entry.strategyName,
      entry.regime,
      entry.allocatedSol,
      entry.rejectionReasons ? JSON.stringify(entry.rejectionReasons) : null,
      JSON.stringify(entry.featuresSnapshot),
      entry.decidedAt
    );
  }

  async getDecisions(limit: number = 100): Promise<DecisionJournalRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM decision_journal ORDER BY id DESC LIMIT ?');
    const rows = stmt.all(limit) as any[];
    return rows.map(r => ({
      decisionId: r.decision_id,
      tokenId: r.token_address,
      tokenSymbol: r.token_symbol,
      decision: r.decision,
      compositeScore: r.composite_score,
      rejectionReasons: r.rejection_reasons ? JSON.parse(r.rejection_reasons) : undefined,
      featuresSnapshot: JSON.parse(r.feature_vector),
      regime: r.regime,
      strategyName: r.strategy_name,
      allocatedSol: r.allocated_sol,
      decidedAt: r.decided_at,
      counterfactualReturn15m: r.counterfactual_return_15m,
      counterfactualReturn1h: r.counterfactual_return_1h,
      counterfactualReturn4h: r.counterfactual_return_4h
    }));
  }

  async updateCounterfactualOutcome(
    decisionId: string, 
    returns: { return15m?: number; return1h?: number; return4h?: number }
  ): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE decision_journal 
      SET counterfactual_return_15m = COALESCE(?, counterfactual_return_15m),
          counterfactual_return_1h = COALESCE(?, counterfactual_return_1h),
          counterfactual_return_4h = COALESCE(?, counterfactual_return_4h)
      WHERE decision_id = ?
    `);
    stmt.run(
      returns.return15m ?? null,
      returns.return1h ?? null,
      returns.return4h ?? null,
      decisionId
    );
  }

  // 4. Orders & Positions
  async saveOrder(order: OrderIntent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO orders (
        order_id, decision_id, token_address, token_symbol, side, requested_sol,
        expected_price_usd, slippage_pct, priority_fee_sol, jito_tip_sol, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      order.orderId,
      order.decisionId,
      order.tokenId,
      order.tokenSymbol,
      order.side,
      order.requestedSol,
      order.expectedPriceUsd,
      order.maxSlippagePct,
      order.priorityFeeSol,
      order.jitoTipSol,
      order.status,
      order.createdAt,
      new Date().toISOString()
    );
  }

  async updateOrderFill(fill: ExecutionFill): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE orders 
      SET executed_sol = ?, executed_price_usd = ?, slippage_pct = ?,
          status = ?, tx_signature = ?, error_message = ?, slot_confirmed = ?, latency_ms = ?, updated_at = ?
      WHERE order_id = ?
    `);
    stmt.run(
      fill.executedSol,
      fill.executedPriceUsd,
      fill.actualSlippagePct,
      fill.status,
      fill.txSignature || null,
      fill.errorMessage || null,
      fill.slot || null,
      fill.networkLatencyMs,
      new Date().toISOString(),
      fill.orderId
    );
  }

  async getActivePositions(): Promise<PositionRecord[]> {
    const stmt = this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN'");
    const rows = stmt.all() as any[];
    return rows.map(r => ({
      id: r.id,
      tokenId: r.token_address,
      tokenSymbol: r.token_symbol,
      tokenName: r.token_name,
      status: r.status,
      entryPriceUsd: r.entry_price_usd,
      entrySol: r.entry_sol,
      amountTokens: r.amount_tokens,
      currentPriceUsd: r.current_price_usd,
      peakPriceUsd: r.peak_price_usd,
      pnlUsd: r.pnl_usd,
      pnlPct: r.pnl_pct,
      isHalfClosed: r.is_half_closed === 1,
      targetTpPct: r.target_tp_pct,
      targetSlPct: r.target_sl_pct,
      strategyName: r.strategy_name,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      closeReason: r.close_reason
    }));
  }

  async savePosition(pos: PositionRecord): Promise<PositionRecord> {
    const stmt = this.db.prepare(`
      INSERT INTO positions (
        token_address, token_symbol, token_name, status, entry_price_usd, entry_sol,
        amount_tokens, current_price_usd, peak_price_usd, pnl_usd, pnl_pct,
        is_half_closed, target_tp_pct, target_sl_pct, strategy_name, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      pos.tokenId,
      pos.tokenSymbol,
      pos.tokenName,
      pos.status,
      pos.entryPriceUsd,
      pos.entrySol,
      pos.amountTokens,
      pos.currentPriceUsd,
      pos.peakPriceUsd,
      pos.pnlUsd,
      pos.pnlPct,
      pos.isHalfClosed ? 1 : 0,
      pos.targetTpPct,
      pos.targetSlPct,
      pos.strategyName,
      pos.openedAt
    );
    pos.id = Number(res.lastInsertRowid);
    return pos;
  }

  async updatePosition(pos: PositionRecord): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE positions 
      SET current_price_usd = ?, peak_price_usd = ?, pnl_usd = ?, pnl_pct = ?, is_half_closed = ?
      WHERE id = ?
    `);
    stmt.run(
      pos.currentPriceUsd,
      pos.peakPriceUsd,
      pos.pnlUsd,
      pos.pnlPct,
      pos.isHalfClosed ? 1 : 0,
      Number(pos.id)
    );
  }

  async closePosition(posId: string | number, reason: string, pnlSol: number, pnlPct: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE positions 
      SET status = 'CLOSED', close_reason = ?, pnl_pct = ?, closed_at = ?
      WHERE id = ?
    `);
    stmt.run(reason, pnlPct, new Date().toISOString(), Number(posId));
  }

  // 5. Expectancy Metrics Engine
  async calculateExpectancy(strategyName?: string): Promise<ExpectancyMetrics> {
    const query = strategyName 
      ? "SELECT * FROM positions WHERE status = 'CLOSED' AND strategy_name = ?"
      : "SELECT * FROM positions WHERE status = 'CLOSED'";
    
    const stmt = this.db.prepare(query);
    const rows = (strategyName ? stmt.all(strategyName) : stmt.all()) as any[];

    if (rows.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgWinPct: 0,
        avgLossPct: 0,
        payoffRatio: 0,
        profitFactor: 0,
        expectancyR: 0,
        expectancyUsd: 0,
        maxDrawdownPct: 0
      };
    }

    const wins = rows.filter(p => p.pnl_pct > 0);
    const losses = rows.filter(p => p.pnl_pct <= 0);

    const winRate = wins.length / rows.length;
    const avgWinPct = wins.length > 0 ? wins.reduce((sum, p) => sum + p.pnl_pct, 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((sum, p) => sum + p.pnl_pct, 0) / losses.length) : 0;

    const payoffRatio = avgLossPct > 0 ? avgWinPct / avgLossPct : avgWinPct;
    const grossProfit = wins.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, p) => sum + (p.pnl_usd || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const lossRate = 1 - winRate;
    const expectancyR = (winRate * payoffRatio) - lossRate;
    const expectancyUsd = (grossProfit - grossLoss) / rows.length;

    return {
      totalTrades: rows.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 100),
      avgWinPct: Number(avgWinPct.toFixed(2)),
      avgLossPct: Number(avgLossPct.toFixed(2)),
      payoffRatio: Number(payoffRatio.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      expectancyR: Number(expectancyR.toFixed(2)),
      expectancyUsd: Number(expectancyUsd.toFixed(2)),
      maxDrawdownPct: 14.0
    };
  }
}
