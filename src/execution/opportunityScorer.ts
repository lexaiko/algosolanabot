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
    // R8 (2026-09-29): cap top-tick momentum. A vertical pump with dd < 1.5%
    // is exit-liquidity shape — it must not earn a high momentum score no
    // matter how vertical. (The old [1.5%, 2%) edge was closed by M12, which
    // moved the rebound gate to >= 1.5%.)
    if (features.drawdownFromPeakPct < 1.5) {
      momentumScore = Math.min(momentumScore, 6);
    }
    positivePoints['Momentum'] = momentumScore;

    // 1.5. Volatility Expansion Component.
    // m9 RECONCILED (2026-09-29): the old code awarded +8 for HIGH_VOLATILITY
    // regime while entryEngine adds a +5 hurdle bump for the SAME regime —
    // high-vol setups cleared the bar +3 EASIER, i.e. the scorer paid for the
    // risk the hurdle was pricing (mixed message). Now the reward only fires in
    // regimes the hurdle does NOT penalize: volatility as tradeability, never
    // as double-paid risk.
    const hostileRegime =
      features.regime === 'PANIC' || features.regime === 'HIGH_VOLATILITY' || features.regime === 'TRENDING_DOWN';
    if (!hostileRegime && features.realizedVol !== undefined && features.realizedVol >= 12.0) {
      positivePoints['Volatility'] = 8;
    }

    // 2. Volume Acceleration Component (Adaptive Weight).
    // C4 (2026-09-29): undefined baseline → 0 points (fail closed), never scored
    // on a synthesized 24h/24 or 24h/288 baseline.
    const volAccelRatio = features.volumeAcceleration === undefined
      ? 0
      : Math.min(features.volumeAcceleration, 3.0) / 3.0;
    const volAccelScore = Math.min(weights.volumeWeight, Math.round(volAccelRatio * weights.volumeWeight));
    positivePoints['Volume'] = volAccelScore;

    // 3. Flow Imbalance Component (Adaptive Weight)
    let flowScore = 0;
    if (features.flowImbalance > 0) {
      flowScore = Math.min(weights.flowWeight, Math.round(features.flowImbalance * weights.flowWeight));
    }
    positivePoints['Flow'] = flowScore;

    // 4. Liquidity Quality Component (Adaptive Weight).
    // m8 (2026-09-29): the old `min(liq/10k, 4)/4` saturated at 1.0 for every
    // candidate past the $35k upstream gate — ~17/20 points for the whole
    // universe, zero discrimination. Now log-scaled over the realistic memecoin
    // range ($10k -> 0 pts, $100k -> full pts) so deeper books actually outscore
    // thinner ones.
    const liqFloor = 10000;
    const liqCeil = 100000;
    const liqLogRatio = Math.max(0, Math.min(1,
      Math.log(Math.max(liqFloor, features.liquidityUsd) / liqFloor) / Math.log(liqCeil / liqFloor)
    ));
    const liquidityScore = Math.min(weights.liquidityWeight, Math.round(liqLogRatio * weights.liquidityWeight));
    positivePoints['Liquidity'] = liquidityScore;

    // 5. Buy-Pressure Component (Adaptive Weight)
    // Estimates only (see FeatureVector docs); unknown values fail closed.
    let buyPressurePts = 0;
    const bpScore = features.buyPressureScore ?? 0;
    if (bpScore >= 60 && (features.netBuyFlowSolEst ?? 0) > 0) {
      buyPressurePts = Math.min(weights.buyPressureWeight, Math.round(((bpScore - 60) / 40) * weights.buyPressureWeight));
    }
    positivePoints['BuyPressure'] = buyPressurePts;

    // 6. Strategy Consensus Bonus (Adaptive Weight).
    // M11 (2026-09-29): the old code paid the FULL bonus whenever >= 2 signals
    // fired — but in the scanner path MOMENTUM, FLOW_IMBALANCE and BUY_PRESSURE
    // all derive from the SAME 5-minute DexScreener window. One observation
    // wearing three hats is not consensus. The full bonus now requires signals
    // from >= 2 INDEPENDENT sourceTags (e.g. tape vs DexScreener field);
    // same-source agreement gets a smaller +4 with this honest label.
    const distinctSources = new Set(signals.map(s => s.sourceTag ?? 'unknown'));
    if (signals.length >= 2) {
      positivePoints['StrategyConsensus'] = distinctSources.size >= 2
        ? weights.consensusBonus
        : Math.min(4, weights.consensusBonus);
    }

    // 7. Pullback-Shape Bonus (R8, 2026-09-29) — structural fix for the
    //    scorer/entry-model mismatch. An ideal pullback (ret5m +6%, dd 4%,
    //    green tick, buy-dominant flow) scored 55/100: below the watching
    //    threshold, far below the 75 hurdle — while 75+ was only reachable by
    //    vertical pumps the entry model forbids. The hurdle stays 75; we fix
    //    WHAT earns points, not the bar. Max +15, fully explainable.
    //    M12 (2026-09-29): healthy-pullback band lowered 2.0% -> 1.5% to match
    //    the closed [1.5%, 2%) gap in entryEngine Invalidation 5.
    let pullbackShapeBonus = 0;
    const pbDd = features.drawdownFromPeakPct;
    if (pbDd >= 1.5 && pbDd <= 8.0) pullbackShapeBonus += 5; // healthy pullback band
    // M2: return1m is a per-minute rate now; undefined (unmeasurable) earns
    // nothing — an unconfirmed rebound is not a green tick.
    if (features.return1m !== undefined && features.return1m > 0) pullbackShapeBonus += 5; // green rebound tick
    if (features.flowImbalance > 0.3) pullbackShapeBonus += 5; // buy-side absorption
    positivePoints['PullbackShape'] = pullbackShapeBonus;

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
