import { FeatureVector, StrategySignal } from '../core/types';
import { adaptiveLearningEngine } from '../strategies/adaptiveLearningEngine';

export interface OpportunityScoreResult {
  compositeScore: number; // 0 - 100
  positivePoints: Record<string, number>;
  penalties: Record<string, number>;
  explanation: string;
}

export class OpportunityScorer {
  /**
   * Generates an explainable, transparent opportunity score based on features and strategy signals,
   * dynamically calibrated by the Adaptive Learning Engine.
   */
  public scoreOpportunity(features: FeatureVector, signals: StrategySignal[]): OpportunityScoreResult {
    const positivePoints: Record<string, number> = {};
    const penalties: Record<string, number> = {};
    const weights = adaptiveLearningEngine.getScoringWeights();

    // 1. Momentum Component (Adaptive Weight)
    let momentumScore = 0;
    if (features.return5m >= 2.5 && features.return5m <= 55.0) {
      momentumScore = Math.min(weights.momentumWeight, Math.round((features.return5m / 35.0) * weights.momentumWeight));
    }
    positivePoints['Momentum'] = momentumScore;

    // 1.5. Volatility Expansion Component (Rewards active trading volatility!)
    if (features.regime === 'HIGH_VOLATILITY' || (features.realizedVol && features.realizedVol >= 12.0)) {
      positivePoints['Volatility'] = 8;
    }

    // 2. Volume Acceleration Component (Adaptive Weight)
    const volAccelRatio = Math.min(features.volumeAcceleration, 3.0) / 3.0;
    const volAccelScore = Math.min(weights.volumeWeight, Math.round(volAccelRatio * weights.volumeWeight));
    positivePoints['Volume'] = volAccelScore;

    // 3. Flow Imbalance Component (Adaptive Weight)
    let flowScore = 0;
    if (features.flowImbalance > 0) {
      flowScore = Math.min(weights.flowWeight, Math.round(features.flowImbalance * weights.flowWeight));
    }
    positivePoints['Flow'] = flowScore;

    // 4. Liquidity Quality Component (Adaptive Weight)
    const liqFloor = 10000;
    const liqRatio = Math.min(features.liquidityUsd / liqFloor, 4.0) / 4.0;
    const liquidityScore = Math.min(weights.liquidityWeight, Math.round(liqRatio * weights.liquidityWeight));
    positivePoints['Liquidity'] = liquidityScore;

    // 5. Buy-Pressure Component (Adaptive Weight)
    // Estimates only (see FeatureVector docs); unknown values fail closed.
    let buyPressurePts = 0;
    const bpScore = features.buyPressureScore ?? 0;
    if (bpScore >= 60 && (features.netBuyFlowSolEst ?? 0) > 0) {
      buyPressurePts = Math.min(weights.buyPressureWeight, Math.round(((bpScore - 60) / 40) * weights.buyPressureWeight));
    }
    positivePoints['BuyPressure'] = buyPressurePts;

    // 6. Strategy Consensus Bonus (Adaptive Weight)
    if (signals.length >= 2) {
      positivePoints['StrategyConsensus'] = weights.consensusBonus;
    }

    // --- PENALTIES ---
    // Slippage / Price impact penalty
    if (features.estimatedPriceImpactPct > 2.5) {
      penalties['SlippageImpact'] = Math.min(15, Math.round(features.estimatedPriceImpactPct * 3));
    }

    // Cabal / Sybil Cluster penalty (skipped when unassessed — unknown is not
    // assumed safe, but the full safety gate in executeBuyToken covers it downstream)
    if (features.cabalClusterRiskScore !== undefined && features.cabalClusterRiskScore > 20) {
      penalties['CabalRisk'] = Math.min(30, Math.round(features.cabalClusterRiskScore * 0.5));
    }

    // Extreme Parabolic Extension penalty (only truly vertical blow-off tops)
    if (features.return5m > 60.0) {
      penalties['ParabolicOverextended'] = 20;
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
