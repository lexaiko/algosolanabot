/**
 * Institutional Quantitative Trading System - Core Domain Models & Event Types
 */

export type OperatingMode = 'BACKTEST' | 'PAPER' | 'SHADOW' | 'LIVE';

export type DataQuality = 'VALID' | 'STALE' | 'SUSPICIOUS';

export type MarketRegimeType = 
  | 'TRENDING_UP' 
  | 'TRENDING_DOWN' 
  | 'RANGE' 
  | 'HIGH_VOLATILITY' 
  | 'LOW_LIQUIDITY' 
  | 'PANIC' 
  | 'UNKNOWN';

export type EntryLifecycleState = 
  | 'WATCHING' 
  | 'SETUP_FORMING' 
  | 'TRIGGERED' 
  | 'CONFIRMED' 
  | 'ENTRY' 
  | 'INVALIDATED';

export type OrderLifecycleState = 
  | 'CREATED' 
  | 'SIMULATED' 
  | 'SIGNED' 
  | 'SUBMITTED' 
  | 'CONFIRMED' 
  | 'FAILED';

export type OrderSide = 'BUY' | 'SELL';

export type DecisionType = 'EXECUTED' | 'SKIPPED' | 'VETOED_RISK' | 'VETOED_SAFETY';

export interface TokenEntity {
  id: string | number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  isPumpFun: boolean;
  discoveredAt: string;
}

export interface PoolEntity {
  id: string | number;
  tokenId: string | number;
  poolAddress: string;
  dexId: 'raydium' | 'pumpfun' | 'orca' | 'meteora' | 'unknown';
  quoteToken: string;
  initialLiquidityUsd: number;
  initialPriceUsd: number;
  discoveredAt: string;
}

export interface MarketEvent {
  eventId: string;
  tokenId: string;
  tokenSymbol: string;
  poolAddress: string;
  source: 'HELIUS_WS' | 'DEXSCREENER' | 'PUMPFUN_PDA' | 'BACKTEST_FEED';
  eventType: 'SWAP' | 'LIQUIDITY_ADD' | 'LIQUIDITY_REMOVE' | 'TICK_PRICE';
  slot?: number;
  timestampMs: number;
  priceUsd: number;
  priceNative: number; // in SOL
  volumeUsd: number;
  liquidityUsd: number;
  makerAddress?: string;
  isBuy: boolean;
  tradeSizeSol?: number;
  dataQuality: DataQuality;
  ingestionLatencyMs?: number;
}

export interface FeatureVector {
  tokenId: string;
  timestampMs: number;
  timeframe: string; // '1m', '5m', '15m'
  
  // Price Structure
  return1m: number;
  return5m: number;
  return15m: number;
  realizedVol: number; // Realized standard deviation
  atrPct: number; // Average True Range %
  breakoutDistancePct: number;
  drawdownFromPeakPct: number;
  upperWickRatio?: number; // (Peak - Close) / (Close - Open), > 0.40 = rejection / long upper shadow

  // Volume & Flow
  volume5mUsd: number;
  volumeAcceleration: number; // dV/dt relative to historical baseline
  buySellRatio: number; // Buy volume / Sell volume
  flowImbalance: number; // (BuyVol - SellVol) / TotalVol (-1.0 to 1.0)
  tradeCount5m: number;
  avgTradeSizeUsd: number;

  // Liquidity Microstructure
  liquidityUsd: number;
  liquidityChangePct: number;
  estimatedPriceImpactPct: number;
  bondingCurveProgressPct?: number;

  // Wallet & Whale Behavior
  whaleNetFlowSol: number;
  smartMoneyAccumulationScore: number; // 0 - 100
  cabalClusterRiskScore: number; // 0 - 100 (0 = clean, 100 = dangerous cluster)

  // Regime
  regime: MarketRegimeType;
  quality: DataQuality;
}

export interface StrategySignal {
  signalId: string;
  tokenId: string;
  tokenSymbol: string;
  strategyName: string;
  strategyVersion: string;
  direction: 'BUY' | 'SELL';
  confidence: number; // 0.00 to 1.00
  regime: MarketRegimeType;
  invalidationPriceUsd: number;
  targetTpPct: number;
  targetSlPct: number;
  suggestedHoldingPeriodMinutes: number;
  featureSnapshot: Partial<FeatureVector>;
  generatedAt: string;
}

export interface CandidateOpportunity {
  opportunityId: string;
  tokenId: string;
  tokenSymbol: string;
  marketEvent: MarketEvent;
  features: FeatureVector;
  signals: StrategySignal[];
  state: EntryLifecycleState;
  compositeScore: number; // 0 - 100
  scoreBreakdown: Record<string, number>;
  evaluatedAt: string;
}

export interface RiskEvaluation {
  allowed: boolean;
  vetoReason?: string;
  hardGateViolations: string[];
  maxAllowedSol: number;
  adjustedTpPct: number;
  adjustedSlPct: number;
  riskMetrics: {
    portfolioDrawdownPct: number;
    dailyLossSol: number;
    consecutiveLosses: number;
    sectorExposureCount: number;
    liquidityDepthPct: number;
  };
}

export interface OrderIntent {
  orderId: string;
  decisionId: string;
  tokenId: string;
  tokenSymbol: string;
  side: OrderSide;
  requestedSol: number;
  expectedPriceUsd: number;
  maxSlippagePct: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  status: OrderLifecycleState;
  createdAt: string;
}

export interface ExecutionFill {
  orderId: string;
  status: 'CONFIRMED' | 'FAILED';
  executedSol: number;
  executedTokens: number;
  executedPriceUsd: number;
  actualSlippagePct: number;
  txSignature?: string;
  slot?: number;
  networkLatencyMs: number;
  feeSol: number;
  errorMessage?: string;
}

export interface PositionRecord {
  id: string | number;
  tokenId: string;
  tokenSymbol: string;
  tokenName: string;
  status: 'OPEN' | 'CLOSED';
  entryPriceUsd: number;
  entrySol: number;
  amountTokens: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  pnlUsd: number;
  pnlPct: number;
  isHalfClosed: boolean;
  targetTpPct: number;
  targetSlPct: number;
  strategyName: string;
  openedAt: string;
  closedAt?: string;
  closeReason?: string;
}

export interface DecisionJournalRecord {
  decisionId: string;
  tokenId: string;
  tokenSymbol: string;
  decision: DecisionType;
  compositeScore: number;
  rejectionReasons?: string[];
  featuresSnapshot: Partial<FeatureVector>;
  regime: MarketRegimeType;
  strategyName: string;
  allocatedSol: number;
  decidedAt: string;
  counterfactualReturn15m?: number;
  counterfactualReturn1h?: number;
  counterfactualReturn4h?: number;
}

export interface ExpectancyMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  payoffRatio: number;
  profitFactor: number;
  expectancyR: number; // Expectancy in R-multiples
  expectancyUsd: number;
  maxDrawdownPct: number;
  sharpeRatio?: number;
  sortinoRatio?: number;
}
