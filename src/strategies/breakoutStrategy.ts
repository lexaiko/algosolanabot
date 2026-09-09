import { IStrategy } from './interfaces';
import { FeatureVector, StrategySignal } from '../core/types';

export class StructuralBreakoutStrategy implements IStrategy {
  id = 'STRAT_STRUCT_BREAKOUT';
  name = 'Structural Breakout Strategy';
  version = '1.0.0';
  description = 'Detects structural volume-backed price breakouts above rolling consolidation resistance.';

  evaluate(features: FeatureVector): StrategySignal | null {
    if (features.regime === 'PANIC' || features.regime === 'LOW_LIQUIDITY') {
      return null;
    }

    // Condition 1: Breakout distance > 3% and return5m positive
    if (features.breakoutDistancePct < 3.0 || features.return5m < 3.0) {
      return null;
    }

    // Condition 2: Volume acceleration must confirm breakout (dV/dt >= 1.4x)
    if (features.volumeAcceleration < 1.4) {
      return null;
    }

    // Condition 3: Buy dominance
    if (features.buySellRatio < 1.5 || features.flowImbalance < 0.2) {
      return null;
    }

    const confidence = Math.min(0.92, 0.65 + (Math.min(features.volumeAcceleration, 3.0) * 0.08));

    return {
      signalId: `SIG_BRK_${features.tokenId.slice(0, 6)}_${Date.now()}`,
      tokenId: features.tokenId,
      tokenSymbol: 'BREAKOUT_TOKEN',
      strategyName: this.name,
      strategyVersion: this.version,
      direction: 'BUY',
      confidence: Number(confidence.toFixed(3)),
      regime: features.regime,
      invalidationPriceUsd: 0,
      targetTpPct: 40.0,
      targetSlPct: 14.0,
      suggestedHoldingPeriodMinutes: 30,
      featureSnapshot: features,
      generatedAt: new Date().toISOString()
    };
  }
}
