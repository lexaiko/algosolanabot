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

export interface IStorageRepository {
  init(): Promise<void>;
  close(): Promise<void>;

  // Tokens & Pools
  saveToken(token: TokenEntity): Promise<TokenEntity>;
  getToken(address: string): Promise<TokenEntity | null>;
  savePool(pool: PoolEntity): Promise<PoolEntity>;
  getPoolByToken(tokenId: string | number): Promise<PoolEntity | null>;

  // Events & Features
  recordMarketEvent(event: MarketEvent): Promise<void>;
  getRecentMarketEvents(tokenAddress: string, limit?: number): Promise<MarketEvent[]>;
  saveFeatureSnapshot(features: FeatureVector): Promise<void>;
  getLatestFeatures(tokenAddress: string): Promise<FeatureVector | null>;

  // Journal (Executed & Skipped candidates)
  recordDecision(entry: DecisionJournalRecord): Promise<void>;
  getDecisions(limit?: number): Promise<DecisionJournalRecord[]>;
  updateCounterfactualOutcome(decisionId: string, returns: { return15m?: number; return1h?: number; return4h?: number }): Promise<void>;

  // Orders & Positions
  saveOrder(order: OrderIntent): Promise<void>;
  updateOrderFill(fill: ExecutionFill): Promise<void>;
  getActivePositions(): Promise<PositionRecord[]>;
  savePosition(pos: PositionRecord): Promise<PositionRecord>;
  updatePosition(pos: PositionRecord): Promise<void>;
  closePosition(posId: string | number, reason: string, pnlSol: number, pnlPct: number): Promise<void>;

  // Analytics & Expectancy
  calculateExpectancy(strategyName?: string): Promise<ExpectancyMetrics>;
}
