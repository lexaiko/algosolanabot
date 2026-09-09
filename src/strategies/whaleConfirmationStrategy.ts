import { IStrategy } from './interfaces';
import { FeatureVector, StrategySignal } from '../core/types';

export class WhaleConfirmationStrategy implements IStrategy {
  id = 'STRAT_WHALE_CONFIRMATION';
  name = 'Qualified Whale Confirmation Strategy';
  version = '1.0.0';
  description = 'Uses qualified historical smart-money accumulation as a multi-factor entry confirmation, rejecting naive top-buyers and cabals.';

  evaluate(features: FeatureVector): StrategySignal | null {
    if (features.regime === 'PANIC') {
      return null;
    }

    // Condition 1: High smart money score
    if (features.smartMoneyAccumulationScore < 65) {
      return null;
    }

    // Condition 2: Positive whale net flow
    if (features.whaleNetFlowSol <= 0) {
      return null;
    }

    // Condition 3: Low cabal cluster risk score (Must NOT be a coordinated sybil/funder dump)
    if (features.cabalClusterRiskScore > 35) {
      return null;
    }

    // Condition 4: Not chasing extreme price extension (> 15% drift)
    if (features.return5m > 18.0) {
      return null;
    }

    const confidence = Math.min(0.95, 0.70 + ((features.smartMoneyAccumulationScore - 65) / 100));

    return {
      signalId: `SIG_WHALE_${features.tokenId.slice(0, 6)}_${Date.now()}`,
      tokenId: features.tokenId,
      tokenSymbol: 'SMART_WHALE_TOKEN',
      strategyName: this.name,
      strategyVersion: this.version,
      direction: 'BUY',
      confidence: Number(confidence.toFixed(3)),
      regime: features.regime,
      invalidationPriceUsd: 0,
      targetTpPct: 42.0,
      targetSlPct: 14.0,
      suggestedHoldingPeriodMinutes: 45,
      featureSnapshot: features,
      generatedAt: new Date().toISOString()
    };
  }
}
