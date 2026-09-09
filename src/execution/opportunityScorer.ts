import { FeatureVector, StrategySignal } from '../core/types';

export interface OpportunityScoreResult {
  compositeScore: number; // 0 - 100
  positivePoints: Record<string, number>;
  penalties: Record<string, number>;
  explanation: string;
}

export class OpportunityScorer {
  /**
   * Generates an explainable, transparent opportunity score based on features and strategy signals
   */
  public scoreOpportunity(features: FeatureVector, signals: StrategySignal[]): OpportunityScoreResult {
    const positivePoints: Record<string, number> = {};
    const penalties: Record<string, number> = {};

    // 1. Momentum Component (0 - 20)
    let momentumScore = 0;
    if (features.return5m >= 4.0 && features.return5m <= 20.0) {
      momentumScore = Math.min(20, Math.round((features.return5m / 20.0) * 20));
    }
    positivePoints['Momentum'] = momentumScore;

    // 2. Volume Acceleration Component (0 - 20)
    const volAccelScore = Math.min(20, Math.round(Math.min(features.volumeAcceleration, 3.0) * 6.5));
    positivePoints['Volume'] = volAccelScore;

    // 3. Flow Imbalance Component (0 - 20)
    let flowScore = 0;
    if (features.flowImbalance > 0) {
      flowScore = Math.min(20, Math.round(features.flowImbalance * 20));
    }
    positivePoints['Flow'] = flowScore;

    // 4. Liquidity Quality Component (0 - 20)
    const liqFloor = 10000;
    const liqRatio = Math.min(features.liquidityUsd / liqFloor, 4.0);
    const liquidityScore = Math.min(20, Math.round(liqRatio * 5));
    positivePoints['Liquidity'] = liquidityScore;

    // 5. Qualified Whale Signal Component (0 - 15)
    let whaleScore = 0;
    if (features.smartMoneyAccumulationScore >= 60 && features.whaleNetFlowSol > 0) {
      whaleScore = Math.min(15, Math.round(((features.smartMoneyAccumulationScore - 60) / 40) * 15));
    }
    positivePoints['Whale'] = whaleScore;

    // 6. Strategy Consensus Bonus (0 - 10)
    if (signals.length >= 2) {
      positivePoints['StrategyConsensus'] = 10;
    }

    // --- PENALTIES ---
    // Slippage / Price impact penalty
    if (features.estimatedPriceImpactPct > 2.5) {
      penalties['SlippageImpact'] = Math.min(15, Math.round(features.estimatedPriceImpactPct * 3));
    }

    // Cabal / Sybil Cluster penalty
    if (features.cabalClusterRiskScore > 20) {
      penalties['CabalRisk'] = Math.min(30, Math.round(features.cabalClusterRiskScore * 0.5));
    }

    // Extreme Parabolic Extension penalty
    if (features.return5m > 22.0) {
      penalties['ParabolicOverextended'] = 20;
    }

    // Regime penalty
    if (features.regime === 'HIGH_VOLATILITY') {
      penalties['HighVolRegime'] = 10;
    }

    const totalPositives = Object.values(positivePoints).reduce((a, b) => a + b, 0);
    const totalPenalties = Object.values(penalties).reduce((a, b) => a + b, 0);
    const rawScore = Math.max(0, Math.min(100, totalPositives - totalPenalties));

    // Format human-readable explanation
    const posStr = Object.entries(positivePoints).map(([k, v]) => `${k} +${v}`).join(', ');
    const penStr = Object.entries(penalties).length > 0 
      ? ` | Penalties: ` + Object.entries(penalties).map(([k, v]) => `${k} -${v}`).join(', ')
      : '';
    const explanation = `Score ${rawScore}/100 [Positive: ${posStr}${penStr}]`;

    return {
      compositeScore: rawScore,
      positivePoints,
      penalties,
      explanation
    };
  }
}

export const opportunityScorer = new OpportunityScorer();
