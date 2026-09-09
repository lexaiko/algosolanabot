import { IStrategy } from './interfaces';
import { FeatureVector, StrategySignal } from '../core/types';

export class OrderFlowImbalanceStrategy implements IStrategy {
  id = 'STRAT_FLOW_IMBALANCE';
  name = 'Order Flow Imbalance Strategy';
  version = '1.0.0';
  description = 'Captures persistent asymmetric buy-side order flow and trade volume pressure.';

  evaluate(features: FeatureVector): StrategySignal | null {
    if (features.regime === 'PANIC' || features.regime === 'LOW_LIQUIDITY') {
      return null;
    }

    // Condition 1: High buy-side flow imbalance
    if (features.flowImbalance < 0.35 || features.buySellRatio < 2.0) {
      return null;
    }

    // Condition 2: Not chasing extreme vertical overextension
    if (features.return5m > 22.0) {
      return null;
    }

    // Condition 3: Trade count support
    if (features.tradeCount5m < 5) {
      return null;
    }

    const confidence = Math.min(0.90, 0.60 + (features.flowImbalance * 0.30));

    return {
      signalId: `SIG_FLOW_${features.tokenId.slice(0, 6)}_${Date.now()}`,
      tokenId: features.tokenId,
      tokenSymbol: 'FLOW_TOKEN',
      strategyName: this.name,
      strategyVersion: this.version,
      direction: 'BUY',
      confidence: Number(confidence.toFixed(3)),
      regime: features.regime,
      invalidationPriceUsd: 0,
      targetTpPct: 35.0,
      targetSlPct: 12.0,
      suggestedHoldingPeriodMinutes: 20,
      featureSnapshot: features,
      generatedAt: new Date().toISOString()
    };
  }
}
