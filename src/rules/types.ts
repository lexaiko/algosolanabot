import { Whale, Position, TokenMarketData, RugCheckResult } from '../types/index';

export type RuleCategory = 'SAFETY' | 'MICROSTRUCTURE' | 'RISK' | 'EXIT';
export type RuleAction = 'ALLOW' | 'REJECT' | 'WARN';
export type ExitAction = 'HOLD' | 'HALF_SELL' | 'FULL_SELL';

export interface RuleContext {
  tokenAddress: string;
  marketData?: TokenMarketData | null;
  safetyData?: RugCheckResult | null;
  whale?: Whale | null;
  whaleEntryPriceUsd?: number | null;
  portfolioBalanceSol: number;
  openPositions: Position[];
  solPriceUsd: number;
  bondingCurveData?: {
    complete: boolean;
    progressPct: number;
    spotPriceSol: number;
    liquiditySol: number;
  } | null;
  cabalData?: {
    isCabal: boolean;
    sharedFunder?: string | null;
    clusteredWhaleCount?: number;
    clusterLabels?: string[];
  } | null;
}

export interface RuleResult {
  ruleId: string;
  ruleName: string;
  category: RuleCategory;
  isHardGate: boolean;
  passed: boolean;
  action: RuleAction;
  score: number; // 0 - 100
  weight: number; // 1 - 10
  reason?: string;
  metricDetails?: Record<string, any>;
}

export interface TradingRule {
  id: string;
  name: string;
  description: string;
  category: RuleCategory;
  isHardGate: boolean;
  weight: number; // Used for composite confidence score calculation
  evaluate(context: RuleContext): Promise<RuleResult> | RuleResult;
}

export interface BuyEvaluationResult {
  allowed: boolean;
  compositeScore: number; // 0 - 100 weighted confidence
  allocatedSol: number;
  targetTpPct: number;
  targetSlPct: number;
  hardGateFailed?: RuleResult;
  rejectionReasons: string[];
  warnings: string[];
  passedRules: string[];
  ruleAuditTrail: RuleResult[];
  executionPlan: {
    recommendedTipLamports: number;
    useJitoBundle: boolean;
    narrative: string;
  };
}

export interface ExitEvaluationContext {
  position: Position;
  currentMarketData?: TokenMarketData | null;
  solPriceUsd: number;
  whaleExited?: boolean;
  whaleSellAmountPct?: number;
  entryLiquidityUsd?: number;
  currentLiquidityUsd?: number;
  peakPriceUsd?: number;
}

export interface ExitEvaluationResult {
  shouldExit: boolean;
  action: ExitAction;
  reason: string;
  ruleTriggered?: string;
  currentPnlPct: number;
  targetPriceUsd?: number;
  details?: Record<string, any>;
}
