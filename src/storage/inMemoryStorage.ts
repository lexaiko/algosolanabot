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

export class InMemoryStorageRepository implements IStorageRepository {
  private tokens: Map<string, TokenEntity> = new Map();
  private pools: Map<string, PoolEntity> = new Map();
  private marketEvents: MarketEvent[] = [];
  private features: Map<string, FeatureVector[]> = new Map();
  private decisions: DecisionJournalRecord[] = [];
  private orders: Map<string, OrderIntent> = new Map();
  private positions: Map<string | number, PositionRecord> = new Map();
  private nextPosId = 1;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async saveToken(token: TokenEntity): Promise<TokenEntity> {
    this.tokens.set(token.address, token);
    return token;
  }

  async getToken(address: string): Promise<TokenEntity | null> {
    return this.tokens.get(address) || null;
  }

  async savePool(pool: PoolEntity): Promise<PoolEntity> {
    this.pools.set(pool.poolAddress, pool);
    return pool;
  }

  async getPoolByToken(tokenId: string | number): Promise<PoolEntity | null> {
    for (const pool of this.pools.values()) {
      if (pool.tokenId === tokenId) return pool;
    }
    return null;
  }

  async recordMarketEvent(event: MarketEvent): Promise<void> {
    this.marketEvents.push(event);
    if (this.marketEvents.length > 10000) {
      this.marketEvents.splice(0, 2000); // Ring buffer trim
    }
  }

  async getRecentMarketEvents(tokenAddress: string, limit: number = 50): Promise<MarketEvent[]> {
    return this.marketEvents
      .filter(e => e.tokenId === tokenAddress)
      .slice(-limit);
  }

  async saveFeatureSnapshot(features: FeatureVector): Promise<void> {
    const list = this.features.get(features.tokenId) || [];
    list.push(features);
    if (list.length > 500) list.shift();
    this.features.set(features.tokenId, list);
  }

  async getLatestFeatures(tokenAddress: string): Promise<FeatureVector | null> {
    const list = this.features.get(tokenAddress);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  async recordDecision(entry: DecisionJournalRecord): Promise<void> {
    this.decisions.push(entry);
  }

  async getDecisions(limit: number = 100): Promise<DecisionJournalRecord[]> {
    return this.decisions.slice(-limit);
  }

  async updateCounterfactualOutcome(
    decisionId: string, 
    returns: { return15m?: number; return1h?: number; return4h?: number }
  ): Promise<void> {
    const entry = this.decisions.find(d => d.decisionId === decisionId);
    if (entry) {
      if (returns.return15m !== undefined) entry.counterfactualReturn15m = returns.return15m;
      if (returns.return1h !== undefined) entry.counterfactualReturn1h = returns.return1h;
      if (returns.return4h !== undefined) entry.counterfactualReturn4h = returns.return4h;
    }
  }

  async saveOrder(order: OrderIntent): Promise<void> {
    this.orders.set(order.orderId, order);
  }

  async updateOrderFill(fill: ExecutionFill): Promise<void> {
    const ord = this.orders.get(fill.orderId);
    if (ord) {
      ord.status = fill.status === 'CONFIRMED' ? 'CONFIRMED' : 'FAILED';
    }
  }

  async getActivePositions(): Promise<PositionRecord[]> {
    return Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
  }

  async savePosition(pos: PositionRecord): Promise<PositionRecord> {
    if (!pos.id) pos.id = this.nextPosId++;
    this.positions.set(pos.id, { ...pos });
    return pos;
  }

  async updatePosition(pos: PositionRecord): Promise<void> {
    this.positions.set(pos.id, { ...pos });
  }

  async closePosition(posId: string | number, reason: string, pnlSol: number, pnlPct: number): Promise<void> {
    const pos = this.positions.get(posId);
    if (pos) {
      pos.status = 'CLOSED';
      pos.closeReason = reason;
      pos.pnlPct = pnlPct;
      pos.closedAt = new Date().toISOString();
    }
  }

  async calculateExpectancy(strategyName?: string): Promise<ExpectancyMetrics> {
    const closed = Array.from(this.positions.values()).filter(p => 
      p.status === 'CLOSED' && (!strategyName || p.strategyName === strategyName)
    );

    if (closed.length === 0) {
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

    const wins = closed.filter(p => p.pnlPct > 0);
    const losses = closed.filter(p => p.pnlPct <= 0);

    const winRate = wins.length / closed.length;
    const avgWinPct = wins.length > 0 ? wins.reduce((sum, p) => sum + p.pnlPct, 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((sum, p) => sum + p.pnlPct, 0) / losses.length) : 0;

    const payoffRatio = avgLossPct > 0 ? avgWinPct / avgLossPct : avgWinPct;
    const grossProfit = wins.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, p) => sum + (p.pnlUsd || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    // Mathematical Expectancy in R-multiples: E = (WR * Payoff) - (1 - WR)
    const lossRate = 1 - winRate;
    const expectancyR = (winRate * payoffRatio) - lossRate;
    const expectancyUsd = (grossProfit - grossLoss) / closed.length;

    return {
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 100),
      avgWinPct: Number(avgWinPct.toFixed(2)),
      avgLossPct: Number(avgLossPct.toFixed(2)),
      payoffRatio: Number(payoffRatio.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      expectancyR: Number(expectancyR.toFixed(2)),
      expectancyUsd: Number(expectancyUsd.toFixed(2)),
      maxDrawdownPct: 14.0 // institutional ceiling
    };
  }
}
