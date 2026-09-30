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

/**
 * Exit classification — single source of truth for every sell decision.
 * Added 2026-09-29 (exit-risk audit F-01/F-06): the old code classified exits
 * with a case-sensitive regex over free-text `reason`, which silently
 * misclassified MANUAL_* sells (blocked when underwater — user could not cut
 * loss) and "TIME_STOP (... Zombie Exit)" (capital Z never matched /ZOMBIE/).
 * Every exit path must now resolve to one of these classes; the phantom-exit
 * guard, stale-price bypass, emergency slippage and breaker counting all key
 * off the class, never off substring matching.
 */
export type ExitClass = 'PROFIT_TAKE' | 'STOP' | 'EMERGENCY' | 'MANUAL' | 'TIME_STOP';

/** M4 (2026-09-29): honest decision lifecycle. The scanner logs EVALUATED (with
 *  a PASS/SKIP verdict) at decision time. EXECUTED is written ONLY by
 *  executeBuyToken after a real fill; FAILED when the buy is rejected/failed.
 *  The old code wrote EXECUTED at verdict time, contaminating the dataset with
 *  fills that never happened. */
export type DecisionType = 'EVALUATED' | 'EXECUTED' | 'FAILED' | 'SKIPPED' | 'VETOED_RISK' | 'VETOED_SAFETY';

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
  /** Observation-time price. Optional for backward compat with old snapshots.
   *  The counterfactual tracker needs this — it was reading priceUsd from the
   *  snapshot but producers never set it (0/446 counterfactuals filled). */
  priceUsd?: number;
  /** GRADUATION LANE (2026-09-30): true when this token entered via a
   *  Raydium migration event (pump.fun graduate). Fresh graduates rarely
   *  score 75+ on thin tape, but continuation proof (3 confirmed higher-high
   *  pushes) is tape-agnostic — the entry engine observes them for
   *  MOMENTUM_CONTINUATION regardless of score. ENTRY still demands the same
   *  3 confirmations + volume + flow, half size. Research: new-pair study
   *  2026-09-30 (n=68) — median 94 min to 2x, all 2x+ excursions dumped >50%
   *  within 24h, so profit comes only from confirmed-leg entry + trailing. */
  isFreshGraduate?: boolean;
  
  // Price Structure
  /** Per-minute rebound rate (%/min) = returnSinceLastPct / minutes between tape
   *  points. M2 (2026-09-29): the old code stuffed the RAW ~10-minute scanner
   *  return here while the name and the R4 gate assumed a 1-minute tick — the
   *  rebound gate was ~10x weaker than designed. Now normalized to %/min.
   *  UNDEFINED when the tape cannot measure it — R4 fails closed (reject). */
  return1m: number | undefined;
  return5m: number;
  /** 15m return from real observations (token tape). Undefined when the tape
   *  is too young — NEVER synthesized from shorter timeframes. */
  return15m?: number;
  realizedVol: number; // Realized standard deviation
  atrPct: number; // Average True Range %
  breakoutDistancePct: number;
  drawdownFromPeakPct: number;
  upperWickRatio?: number; // (Peak - Close) / (Close - Open), > 0.40 = rejection / long upper shadow

  // Volume & Flow
  /** 5m volume in USD. UNDEFINED when unmeasured (C4/M7, 2026-09-29). */
  volume5mUsd?: number;
  /** RVOL vs 1h baseline. UNDEFINED when the baseline is missing (C4, 2026-09-29) —
   *  never synthesized from 24h/24 or 24h/288. Consumers must fail closed. */
  volumeAcceleration?: number; // dV/dt relative to historical baseline
  /** Buy volume / Sell volume. UNDEFINED when sells5m == 0 or flow is unknown
   *  (C3, 2026-09-29) — "no sells measured" is not infinite dominance.
   *  Consumers must fail closed (use flowImbalance for the dominance question). */
  buySellRatio?: number; // Buy volume / Sell volume
  flowImbalance: number; // (BuyVol - SellVol) / TotalVol (-1.0 to 1.0)
  tradeCount5m: number;
  /** m15 (2026-09-29): UNDEFINED when unmeasured. The old $80 fallback fed
   *  netBuyFlowSolEst from a guessed trade size. */
  avgTradeSizeUsd: number | undefined;

  // Liquidity Microstructure
  liquidityUsd: number;
  /** Undefined when not measured. Was hardcoded 0 in several producers. */
  liquidityChangePct?: number;
  estimatedPriceImpactPct: number;
  bondingCurveProgressPct?: number;

  // Buy-pressure estimation (HONEST LABELS — 2026-09-29).
  // This project does NOT track whale wallets. These fields are estimates
  // derived from aggregate buy/sell counts, not smart-money surveillance.
  /** Estimated net buy-side flow in SOL = f(buy/sell ratio, avg trade size).
   *  Heuristic, not wallet tracking. Undefined when trade-count data is thin. */
  netBuyFlowSolEst?: number;
  /** 0-100 bucketed buy-pressure score derived from buy/sell ratio only.
   *  Heuristic estimate, NOT smart-wallet analysis despite the old name. */
  buyPressureScore?: number;
  /** 0-100 (0 = clean). Coarse heuristic from the safety gate where available.
   *  Undefined when not assessed — gates must skip, not assume safe. */
  cabalClusterRiskScore?: number;

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
  /** M11 (2026-09-29): provenance tag of the data window behind this signal
   *  (e.g. 'dexscreener-5m', 'tape-1m'). The consensus bonus is only paid in
   *  full when signals come from INDEPENDENT sources — signals from the same
   *  window wearing different hats are not consensus. */
  sourceTag?: string;
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
  /** M4: scanner verdict at EVALUATED time (PASS = would buy, SKIP = rejected). */
  verdict?: 'PASS' | 'SKIP';
  /** M4: set only when decision becomes EXECUTED (real fill). */
  positionId?: number;
  /** M4: ISO timestamp of the real fill. */
  executedAt?: string;
  compositeScore: number;
  rejectionReasons?: string[];
  featuresSnapshot: Partial<FeatureVector>;
  regime: MarketRegimeType;
  strategyName: string;
  allocatedSol: number;
  decidedAt: string;
  /** 2026-09-30 (supervisor): first-seen discovery feed
   *  ('raydium_vol' | 'raydium_apr' | 'gecko_trending' | 'unknown'). */
  discoverySource?: string;
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
