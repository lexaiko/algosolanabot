import { 
  OperatingMode, 
  MarketEvent, 
  PositionRecord, 
  ExpectancyMetrics,
  DecisionJournalRecord
} from '../core/types';
import { IStorageRepository, getStorageRepository } from '../storage/index';
import { MarketDataEngine } from '../market/marketDataEngine';
import { DiscoveryFunnel, FunnelCandidate } from '../market/discoveryFunnel';
import { FeatureEngine } from '../features/featureEngine';
import { RegimeEngine } from '../strategies/regimeEngine';
import { StrategyEngine } from '../strategies/strategyEngine';
import { OpportunityScorer } from '../execution/opportunityScorer';
import { EntryEngine } from '../execution/entryEngine';
import { InstitutionalRiskEngine } from '../risk/riskEngine';
import { ExecutionEngine } from '../execution/executionEngine';
import { PositionManager } from '../execution/positionManager';
import { DecisionJournal } from '../journal/decisionJournal';
import { ExpectancyEngine, StrategyHealthEvaluation } from '../journal/expectancyEngine';
import { CONFIG } from '../config';

export class SystematicTradingSystem {
  public storage: IStorageRepository;
  public marketData: MarketDataEngine;
  public funnel: DiscoveryFunnel;
  public features: FeatureEngine;
  public regime: RegimeEngine;
  public strategies: StrategyEngine;
  public scorer: OpportunityScorer;
  public entry: EntryEngine;
  public risk: InstitutionalRiskEngine;
  public execution: ExecutionEngine;
  public positions: PositionManager;
  public journal: DecisionJournal;
  public expectancy: ExpectancyEngine;

  private isPaused: boolean = false;
  private mode: OperatingMode = 'PAPER';

  constructor(storage?: IStorageRepository, mode: OperatingMode = 'PAPER') {
    this.storage = storage || getStorageRepository();
    this.mode = mode;

    this.marketData = new MarketDataEngine(this.storage);
    this.funnel = new DiscoveryFunnel();
    this.features = new FeatureEngine(this.storage);
    this.regime = new RegimeEngine();
    this.strategies = new StrategyEngine();
    this.scorer = new OpportunityScorer();
    this.entry = new EntryEngine(this.scorer);
    this.risk = new InstitutionalRiskEngine();
    this.execution = new ExecutionEngine(this.storage, this.mode);
    this.positions = new PositionManager(this.storage);
    this.journal = new DecisionJournal(this.storage);
    this.expectancy = new ExpectancyEngine(this.storage);
  }

  public setMode(mode: OperatingMode) {
    this.mode = mode;
    this.execution.setMode(mode);
  }

  public getMode(): OperatingMode {
    return this.mode;
  }

  public pauseTrading() {
    this.isPaused = true;
  }

  public resumeTrading() {
    this.isPaused = false;
  }

  public isTradingPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Evaluates a live incoming market candidate through the institutional quantitative pipeline
   */
  public async processCandidate(params: {
    candidate: FunnelCandidate;
    solPriceUsd: number;
    portfolioBalanceSol: number;
    consecutiveLosses: number;
    dailyLossSol: number;
  }): Promise<{
    processed: boolean;
    decision: 'EXECUTED' | 'SKIPPED' | 'VETOED_SAFETY' | 'VETOED_RISK' | 'PAUSED';
    reason: string;
    score: number;
    allocatedSol: number;
  }> {
    if (this.isPaused) {
      return {
        processed: false,
        decision: 'PAUSED',
        reason: 'Sistem trading sedang di-pause oleh admin',
        score: 0,
        allocatedSol: 0
      };
    }

    const { candidate, solPriceUsd, portfolioBalanceSol, consecutiveLosses, dailyLossSol } = params;

    // 1. Discovery Funnel & Safety Gates
    const funnelEval = this.funnel.evaluateCandidate(candidate);
    if (!funnelEval.passed) {
      await this.journal.logCandidateDecision({
        tokenId: candidate.token.address,
        tokenSymbol: candidate.token.symbol,
        decision: 'VETOED_SAFETY',
        compositeScore: 0,
        rejectionReasons: [funnelEval.reason || 'Safety gate hard block'],
        featuresSnapshot: {},
        regime: 'UNKNOWN',
        strategyName: 'SAFETY_GATE'
      });

      return {
        processed: true,
        decision: 'VETOED_SAFETY',
        reason: funnelEval.reason || 'Gagal melewati safety gate',
        score: 0,
        allocatedSol: 0
      };
    }

    // 2. Feature Compute
    const featureVector = await this.features.computeFeatures({
      tokenAddress: candidate.token.address,
      currentPriceUsd: candidate.priceUsd,
      currentLiquidityUsd: candidate.liquidityUsd,
      volume24hUsd: candidate.volume24hUsd,
      bondingCurveProgressPct: 50.0,
      smartMoneyScore: 70
    });

    // 3. Regime Detection
    const currentRegime = this.regime.detectRegime(featureVector);
    featureVector.regime = currentRegime;

    // 4. Strategy Engine
    const signals = this.strategies.evaluateFeatures(featureVector);

    // 5. Entry Timing State Machine
    const entryEval = this.entry.evaluateEntryTiming(featureVector, signals);
    if (!entryEval.shouldEnter) {
      await this.journal.logCandidateDecision({
        tokenId: candidate.token.address,
        tokenSymbol: candidate.token.symbol,
        decision: 'SKIPPED',
        compositeScore: entryEval.compositeScore,
        rejectionReasons: [entryEval.reason],
        featuresSnapshot: featureVector,
        regime: currentRegime,
        strategyName: signals[0]?.strategyName || 'NONE'
      });

      return {
        processed: true,
        decision: 'SKIPPED',
        reason: entryEval.reason,
        score: entryEval.compositeScore,
        allocatedSol: 0
      };
    }

    // 6. Institutional Risk Engine (Veto & Dynamic Sizing)
    const openPositions = await this.storage.getActivePositions();
    const riskEval = this.risk.evaluateTradeRisk({
      features: featureVector,
      signals,
      portfolioBalanceSol,
      openPositions,
      dailyLossSol,
      consecutiveLosses,
      solPriceUsd
    });

    if (!riskEval.allowed) {
      await this.journal.logCandidateDecision({
        tokenId: candidate.token.address,
        tokenSymbol: candidate.token.symbol,
        decision: 'VETOED_RISK',
        compositeScore: entryEval.compositeScore,
        rejectionReasons: riskEval.hardGateViolations,
        featuresSnapshot: featureVector,
        regime: currentRegime,
        strategyName: signals[0]?.strategyName || 'NONE'
      });

      return {
        processed: true,
        decision: 'VETOED_RISK',
        reason: riskEval.vetoReason || 'Risk engine vetoed trade',
        score: entryEval.compositeScore,
        allocatedSol: 0
      };
    }

    // 7. Execution Engine
    const orderIntent = {
      orderId: `ORD_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      decisionId: `DEC_${Date.now()}`,
      tokenId: candidate.token.address,
      tokenSymbol: candidate.token.symbol,
      side: 'BUY' as const,
      requestedSol: riskEval.maxAllowedSol,
      expectedPriceUsd: candidate.priceUsd,
      maxSlippagePct: 2.5,
      priorityFeeSol: 0.0005,
      jitoTipSol: 0.0005,
      status: 'CREATED' as const,
      createdAt: new Date().toISOString()
    };

    const fill = await this.execution.executeOrder(orderIntent);

    if (fill.status === 'CONFIRMED') {
      const newPos: PositionRecord = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        tokenId: candidate.token.address,
        tokenSymbol: candidate.token.symbol,
        tokenName: candidate.token.name,
        status: 'OPEN',
        entryPriceUsd: fill.executedPriceUsd,
        entrySol: riskEval.maxAllowedSol,
        amountTokens: fill.executedTokens,
        currentPriceUsd: fill.executedPriceUsd,
        peakPriceUsd: fill.executedPriceUsd,
        pnlUsd: 0,
        pnlPct: 0,
        isHalfClosed: false,
        targetTpPct: riskEval.adjustedTpPct,
        targetSlPct: riskEval.adjustedSlPct,
        strategyName: signals[0]?.strategyName || 'MOMENTUM',
        openedAt: new Date().toISOString()
      };

      await this.storage.savePosition(newPos);

      await this.journal.logCandidateDecision({
        tokenId: candidate.token.address,
        tokenSymbol: candidate.token.symbol,
        decision: 'EXECUTED',
        compositeScore: entryEval.compositeScore,
        featuresSnapshot: featureVector,
        regime: currentRegime,
        strategyName: signals[0]?.strategyName || 'MOMENTUM',
        allocatedSol: riskEval.maxAllowedSol
      });

      return {
        processed: true,
        decision: 'EXECUTED',
        reason: `Order confirmed: ${riskEval.maxAllowedSol} SOL di harga $${fill.executedPriceUsd}`,
        score: entryEval.compositeScore,
        allocatedSol: riskEval.maxAllowedSol
      };
    }

    return {
      processed: true,
      decision: 'SKIPPED',
      reason: fill.errorMessage || 'Eksekusi order gagal di layer DEX',
      score: entryEval.compositeScore,
      allocatedSol: 0
    };
  }

  /**
   * Generates comprehensive system operational status
   */
  public async getSystemStatus(): Promise<{
    mode: OperatingMode;
    isPaused: boolean;
    openPositionsCount: number;
    health: StrategyHealthEvaluation;
  }> {
    const active = await this.storage.getActivePositions();
    const health = await this.expectancy.evaluateStrategyHealth();

    return {
      mode: this.mode,
      isPaused: this.isPaused,
      openPositionsCount: active.length,
      health
    };
  }
}

export const tradingSystem = new SystematicTradingSystem();
