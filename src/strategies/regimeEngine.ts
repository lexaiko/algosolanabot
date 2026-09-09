import { FeatureVector, MarketRegimeType } from '../core/types';

export class RegimeEngine {
  /**
   * Classifies market regime from quantitative feature metrics
   */
  public detectRegime(features: Partial<FeatureVector>): MarketRegimeType {
    const return5m = features.return5m || 0;
    const return15m = features.return15m || 0;
    const realizedVol = features.realizedVol || 5.0;
    const flowImbalance = features.flowImbalance || 0;
    const liquidityUsd = features.liquidityUsd || 50000;
    const drawdownPct = features.drawdownFromPeakPct || 0;

    // 1. Panic Dump Regime (Highest Defensive Urgency)
    if (drawdownPct >= 25.0 && flowImbalance <= -0.4) {
      return 'PANIC';
    }

    // 2. Low Liquidity Regime
    if (liquidityUsd < 12000) {
      return 'LOW_LIQUIDITY';
    }

    // 3. High Volatility Regime
    if (realizedVol > 18.0) {
      return 'HIGH_VOLATILITY';
    }

    // 4. Trending Up Regime
    if (return5m >= 4.0 && return15m >= 8.0 && flowImbalance >= 0.15) {
      return 'TRENDING_UP';
    }

    // 5. Trending Down Regime
    if (return5m <= -4.0 && return15m <= -8.0 && flowImbalance <= -0.15) {
      return 'TRENDING_DOWN';
    }

    // 6. Range / Consolidation Regime
    if (Math.abs(return5m) <= 3.5 && Math.abs(flowImbalance) <= 0.20) {
      return 'RANGE';
    }

    return 'UNKNOWN';
  }
}

export const regimeEngine = new RegimeEngine();
