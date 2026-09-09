import { IStrategy } from './interfaces';
import { FeatureVector, StrategySignal } from '../core/types';

export class MomentumContinuationStrategy implements IStrategy {
  id = 'STRAT_MOMENTUM_CONT';
  name = 'Momentum Continuation Strategy';
  version = '1.0.0';
  description = 'Captures persistent multi-horizon momentum while filtering out one-candle parabolic spikes.';

  evaluate(features: FeatureVector): StrategySignal | null {
    // Regime filter: Disabled in Panic or Low Liquidity
    if (features.regime === 'PANIC' || features.regime === 'LOW_LIQUIDITY') {
      return null;
    }

    // Condition 1: Steady sustained momentum (return5m between 4% and 20%)
    if (features.return5m < 4.0 || features.return5m > 20.0) {
      return null;
    }

    // Condition 2: Flow imbalance must be buy-dominant
    if (features.flowImbalance < 0.15 || features.buySellRatio < 1.3) {
      return null;
    }

    // Condition 3: Not severely drawn down
    if (features.drawdownFromPeakPct > 12.0) {
      return null;
    }

    const confidence = Math.min(0.95, 0.60 + (features.flowImbalance * 0.25) + (features.return1m > 0 ? 0.10 : 0));

    return {
      signalId: `SIG_MOM_${features.tokenId.slice(0, 6)}_${Date.now()}`,
      tokenId: features.tokenId,
      tokenSymbol: 'MOMENTUM_TOKEN',
      strategyName: this.name,
      strategyVersion: this.version,
      direction: 'BUY',
      confidence: Number(confidence.toFixed(3)),
      regime: features.regime,
      invalidationPriceUsd: 0,
      targetTpPct: 35.0,
      targetSlPct: 12.0,
      suggestedHoldingPeriodMinutes: 15,
      featureSnapshot: features,
      generatedAt: new Date().toISOString()
    };
  }
}
