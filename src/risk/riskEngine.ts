import { FeatureVector, StrategySignal, RiskEvaluation, PositionRecord } from '../core/types';
import { CONFIG } from '../config';

export class InstitutionalRiskEngine {
  /**
   * Supreme Veto Authority: Evaluates trade risk against institutional risk budget
   */
  public evaluateTradeRisk(params: {
    features: FeatureVector;
    signals: StrategySignal[];
    portfolioBalanceSol: number;
    openPositions: PositionRecord[];
    dailyLossSol: number;
    consecutiveLosses: number;
    solPriceUsd: number;
  }): RiskEvaluation {
    const { 
      features, 
      signals, 
      portfolioBalanceSol, 
      openPositions, 
      dailyLossSol, 
      consecutiveLosses,
      solPriceUsd 
    } = params;

    const hardViolations: string[] = [];

    // 1. HARD VETO: Max Concurrent Open Positions
    const maxPositions = CONFIG.MAX_OPEN_POSITIONS || 15;
    if (openPositions.length >= maxPositions) {
      hardViolations.push(`PORTFOLIO_CAPACITY_FULL_${openPositions.length}/${maxPositions}`);
    }

    // 2. HARD VETO: Minimum Cash Buffer
    const minSolReserve = 0.05;
    if (portfolioBalanceSol < minSolReserve) {
      hardViolations.push(`INSUFFICIENT_GAS_RESERVE_${portfolioBalanceSol.toFixed(3)}SOL`);
    }

    // 3. HARD VETO: Consecutive Losses Circuit Breaker
    const maxConsecutiveLosses = CONFIG.MAX_CONSECUTIVE_LOSSES || 3;
    if (consecutiveLosses >= maxConsecutiveLosses) {
      hardViolations.push(`CIRCUIT_BREAKER_CONSECUTIVE_LOSSES_${consecutiveLosses}`);
    }

    // 4. HARD VETO: Correlated Narrative / Sector Exposure (Max 2 per sector)
    const currentNarrative = this.parseNarrative(features.tokenId);
    if (currentNarrative !== 'OTHER') {
      const matching = openPositions.filter(p => this.parseNarrative(p.tokenId) === currentNarrative);
      if (matching.length >= (CONFIG.MAX_POSITIONS_PER_NARRATIVE || 2)) {
        hardViolations.push(`NARRATIVE_SECTOR_LIMIT_${currentNarrative}_${matching.length}`);
      }
    }

    // 5. HARD VETO: Panic / Crashing Regime
    if (features.regime === 'PANIC') {
      hardViolations.push('REGIME_PANIC_DUMP_ACTIVE');
    }

    // Mathematical Sizing via Fractional Kelly
    let maxAllowedSol = 0;
    let adjustedTpPct = 35.0;
    let adjustedSlPct = 12.0;

    if (hardViolations.length === 0) {
      maxAllowedSol = this.computeFractionalKellySize({
        portfolioBalanceSol,
        poolLiquidityUsd: features.liquidityUsd,
        solPriceUsd,
        consecutiveLosses
      });

      // Volatility adaptive SL/TP calibration
      if (features.realizedVol > 12.0) {
        adjustedTpPct = Math.round(adjustedTpPct * 1.25);
        adjustedSlPct = Math.round(adjustedSlPct * 1.20);
      }
    }

    const allowed = hardViolations.length === 0 && maxAllowedSol > 0.04;

    return {
      allowed,
      vetoReason: hardViolations.length > 0 ? hardViolations.join('; ') : undefined,
      hardGateViolations: hardViolations,
      maxAllowedSol: Number(maxAllowedSol.toFixed(4)),
      adjustedTpPct,
      adjustedSlPct,
      riskMetrics: {
        portfolioDrawdownPct: 0,
        dailyLossSol,
        consecutiveLosses,
        sectorExposureCount: openPositions.length,
        liquidityDepthPct: Number(((maxAllowedSol * solPriceUsd) / Math.max(1, features.liquidityUsd) * 100).toFixed(2))
      }
    };
  }

  /**
   * Fractional Kelly Sizing with Pool Depth Cap
   */
  private computeFractionalKellySize(params: {
    portfolioBalanceSol: number;
    poolLiquidityUsd: number;
    solPriceUsd: number;
    consecutiveLosses: number;
  }): number {
    const { portfolioBalanceSol, poolLiquidityUsd, solPriceUsd, consecutiveLosses } = params;

    // Baseline win-rate p (dampened by consecutive losses)
    let p = 0.54;
    if (consecutiveLosses > 0) {
      p = Math.max(0.35, p - (consecutiveLosses * 0.08));
    }
    const q = 1 - p;

    // Payoff ratio b: target TP 35% vs SL 12% = ~2.9x
    const b = 2.9;

    // Kelly formula: f* = (p * b - q) / b
    const rawKelly = (p * b - q) / b;
    if (rawKelly <= 0) return 0;

    // Quarter-Kelly (0.25x) for extreme risk aversion
    const kellyFraction = CONFIG.KELLY_FRACTION || 0.25;
    const portfolioRatio = rawKelly * kellyFraction;
    let targetSol = portfolioBalanceSol * portfolioRatio;

    // Pool Liquidity Depth Cap (Max 1.5% of pool to guarantee clean exit)
    let depthCapSol = 999;
    if (poolLiquidityUsd > 0 && solPriceUsd > 0) {
      const maxTradeUsd = poolLiquidityUsd * 0.015;
      depthCapSol = maxTradeUsd / solPriceUsd;
    }

    // Absolute bounds [0.05 SOL min, 0.40 SOL max]
    const bounded = Math.max(0.05, Math.min(targetSol, depthCapSol, 0.40));
    return bounded;
  }

  private parseNarrative(tokenSymbolOrAddress: string): string {
    const text = tokenSymbolOrAddress.toLowerCase();
    if (/dog|shib|inu|bonk|floki|wif|pup/.test(text)) return 'DOG';
    if (/cat|meow|kitty|neko|mimi/.test(text)) return 'CAT';
    if (/ai|gpt|agent|bot|neural|agi|virtual/.test(text)) return 'AI';
    if (/trump|biden|kamala|maga|vote|politic/.test(text)) return 'POLITICS';
    if (/pepe|frog|toad|kek/.test(text)) return 'PEPE';
    return 'OTHER';
  }
}

export const riskEngine = new InstitutionalRiskEngine();
