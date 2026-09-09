import { MarketEvent, FeatureVector, PositionRecord, ExpectancyMetrics } from '../core/types';
import { InMemoryStorageRepository } from '../storage/inMemoryStorage';
import { FeatureEngine } from '../features/featureEngine';
import { RegimeEngine } from '../strategies/regimeEngine';
import { StrategyEngine } from '../strategies/strategyEngine';
import { EntryEngine } from '../execution/entryEngine';
import { InstitutionalRiskEngine } from '../risk/riskEngine';
import { ExecutionEngine } from '../execution/executionEngine';
import { PositionManager } from '../execution/positionManager';
import { DecisionJournal } from '../journal/decisionJournal';

export interface BacktestConfig {
  initialBalanceSol: number;
  simulatedSlippagePct: number;
  simulatedFeeSol: number;
  solPriceUsd: number;
}

export interface BacktestSummary {
  totalEventsProcessed: number;
  totalCandidatesEvaluated: number;
  totalOrdersExecuted: number;
  totalOrdersSkipped: number;
  totalOrdersVetoed: number;
  endingBalanceSol: number;
  netPnlSol: number;
  metrics: ExpectancyMetrics;
  closedPositions: PositionRecord[];
}

export class EventBacktester {
  private config: BacktestConfig;

  constructor(config: Partial<BacktestConfig> = {}) {
    this.config = {
      initialBalanceSol: config.initialBalanceSol || 10.0,
      simulatedSlippagePct: config.simulatedSlippagePct || 0.35,
      simulatedFeeSol: config.simulatedFeeSol || 0.0015,
      solPriceUsd: config.solPriceUsd || 150.0
    };
  }

  /**
   * Replays an event stream deterministically through the institutional trading stack
   */
  public async runBacktest(events: MarketEvent[]): Promise<BacktestSummary> {
    const storage = new InMemoryStorageRepository();
    const featureEngine = new FeatureEngine(storage);
    const regimeEngine = new RegimeEngine();
    const strategyEngine = new StrategyEngine();
    const entryEngine = new EntryEngine();
    const riskEngine = new InstitutionalRiskEngine();
    const executionEngine = new ExecutionEngine(storage, 'BACKTEST');
    const positionManager = new PositionManager(storage);
    const journal = new DecisionJournal(storage);

    let currentBalanceSol = this.config.initialBalanceSol;
    let candidatesEvaluated = 0;
    let ordersExecuted = 0;
    let ordersSkipped = 0;
    let ordersVetoed = 0;
    let consecutiveLosses = 0;

    for (const event of events) {
      // 1. Ingest event into storage
      await storage.recordMarketEvent(event);

      // 2. Evaluate active open positions for exits
      const activePositions = await storage.getActivePositions();
      for (const pos of activePositions) {
        if (pos.tokenId === event.tokenId) {
          const exitSignal = positionManager.evaluatePositionExit({
            position: pos,
            currentPriceUsd: event.priceUsd,
            currentLiquidityUsd: event.liquidityUsd
          });

          if (exitSignal.shouldExit) {
            if (exitSignal.action === 'HALF_SELL') {
              pos.isHalfClosed = true;
              const partialReturnSol = (pos.entrySol * 0.5) * (1 + pos.pnlPct / 100);
              currentBalanceSol += partialReturnSol;
              await storage.updatePosition(pos);
            } else if (exitSignal.action === 'FULL_SELL') {
              const returnedSol = pos.isHalfClosed 
                ? (pos.entrySol * 0.5) * (1 + pos.pnlPct / 100)
                : pos.entrySol * (1 + pos.pnlPct / 100);
              currentBalanceSol += returnedSol;

              if (pos.pnlPct <= 0) consecutiveLosses++;
              else consecutiveLosses = 0;

              await storage.closePosition(pos.id, exitSignal.reason, (pos.pnlPct / 100) * pos.entrySol, pos.pnlPct);
            }
          }
        }
      }

      // 3. Compute Features for candidate discovery
      const features = await featureEngine.computeFeatures({
        tokenAddress: event.tokenId,
        currentPriceUsd: event.priceUsd,
        currentLiquidityUsd: event.liquidityUsd,
        volume24hUsd: event.volumeUsd * 24,
        priceChange5m: 5.5,
        bondingCurveProgressPct: 45.0
      });

      // 4. Detect Regime
      const regime = regimeEngine.detectRegime(features);
      features.regime = regime;

      // 5. Generate Strategy Signals
      const signals = strategyEngine.evaluateFeatures(features);
      candidatesEvaluated++;

      // 6. Evaluate Entry Timing State Machine
      const entryDecision = entryEngine.evaluateEntryTiming(features, signals);

      if (!entryDecision.shouldEnter) {
        ordersSkipped++;
        await journal.logCandidateDecision({
          tokenId: event.tokenId,
          tokenSymbol: event.tokenSymbol,
          decision: 'SKIPPED',
          compositeScore: entryDecision.compositeScore,
          rejectionReasons: [entryDecision.reason],
          featuresSnapshot: features,
          regime,
          strategyName: signals[0]?.strategyName || 'NONE'
        });
        continue;
      }

      // 7. Risk Engine Veto & Dynamic Sizing
      const riskDecision = riskEngine.evaluateTradeRisk({
        features,
        signals,
        portfolioBalanceSol: currentBalanceSol,
        openPositions: await storage.getActivePositions(),
        dailyLossSol: 0,
        consecutiveLosses,
        solPriceUsd: this.config.solPriceUsd
      });

      if (!riskDecision.allowed) {
        ordersVetoed++;
        await journal.logCandidateDecision({
          tokenId: event.tokenId,
          tokenSymbol: event.tokenSymbol,
          decision: 'VETOED_RISK',
          compositeScore: entryDecision.compositeScore,
          rejectionReasons: riskDecision.hardGateViolations,
          featuresSnapshot: features,
          regime,
          strategyName: signals[0]?.strategyName || 'NONE'
        });
        continue;
      }

      // 8. Execute Order via Execution Engine (Backtest Simulation)
      const allocatedSol = riskDecision.maxAllowedSol;
      const orderIntent = {
        orderId: `ORD_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        decisionId: `DEC_${Date.now()}`,
        tokenId: event.tokenId,
        tokenSymbol: event.tokenSymbol,
        side: 'BUY' as const,
        requestedSol: allocatedSol,
        expectedPriceUsd: event.priceUsd,
        maxSlippagePct: 2.5,
        priorityFeeSol: 0.0005,
        jitoTipSol: 0.0005,
        status: 'CREATED' as const,
        createdAt: new Date().toISOString()
      };

      const fill = await executionEngine.executeOrder(orderIntent);

      if (fill.status === 'CONFIRMED') {
        currentBalanceSol -= (allocatedSol + fill.feeSol);
        ordersExecuted++;

        const newPos: PositionRecord = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          tokenId: event.tokenId,
          tokenSymbol: event.tokenSymbol,
          tokenName: event.tokenSymbol,
          status: 'OPEN',
          entryPriceUsd: fill.executedPriceUsd,
          entrySol: allocatedSol,
          amountTokens: fill.executedTokens,
          currentPriceUsd: fill.executedPriceUsd,
          peakPriceUsd: fill.executedPriceUsd,
          pnlUsd: 0,
          pnlPct: 0,
          isHalfClosed: false,
          targetTpPct: riskDecision.adjustedTpPct,
          targetSlPct: riskDecision.adjustedSlPct,
          strategyName: signals[0]?.strategyName || 'MOMENTUM',
          openedAt: new Date().toISOString()
        };

        await storage.savePosition(newPos);

        await journal.logCandidateDecision({
          tokenId: event.tokenId,
          tokenSymbol: event.tokenSymbol,
          decision: 'EXECUTED',
          compositeScore: entryDecision.compositeScore,
          featuresSnapshot: features,
          regime,
          strategyName: signals[0]?.strategyName || 'MOMENTUM',
          allocatedSol
        });
      }
    }

    const metrics = await storage.calculateExpectancy();
    const allPositions = (await storage.getActivePositions());

    return {
      totalEventsProcessed: events.length,
      totalCandidatesEvaluated: candidatesEvaluated,
      totalOrdersExecuted: ordersExecuted,
      totalOrdersSkipped: ordersSkipped,
      totalOrdersVetoed: ordersVetoed,
      endingBalanceSol: Number(currentBalanceSol.toFixed(3)),
      netPnlSol: Number((currentBalanceSol - this.config.initialBalanceSol).toFixed(3)),
      metrics,
      closedPositions: allPositions
    };
  }
}
