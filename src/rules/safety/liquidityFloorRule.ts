import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export class LiquidityFloorRule implements TradingRule {
  id = 'SAFETY_LIQUIDITY_FLOOR';
  name = 'Liquidity & Market Cap Floor Gate';
  description = 'Ensures adequate pool depth and valuation to prevent catastrophic price impact and illiquidity traps.';
  category = 'SAFETY' as const;
  isHardGate = true;
  weight = 9;

  evaluate(context: RuleContext): RuleResult {
    const { marketData, bondingCurveData, tokenAddress, solPriceUsd } = context;

    if (!marketData) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 0,
        weight: this.weight,
        reason: `Data likuiditas tidak ditemukan untuk token ${tokenAddress}`
      };
    }

    const isPumpFun = tokenAddress.endsWith('pump') || marketData.dexId === 'pumpfun';
    let effectiveLiquidityUsd = marketData.liquidityUsd;

    // Direct On-Chain Pump.fun PDA Virtual Liquidity Calculation
    if (isPumpFun && bondingCurveData && bondingCurveData.liquiditySol > 0 && solPriceUsd > 0) {
      effectiveLiquidityUsd = Math.max(effectiveLiquidityUsd, bondingCurveData.liquiditySol * solPriceUsd);
    } else if (isPumpFun && effectiveLiquidityUsd <= 0 && marketData.marketCap >= 5000) {
      // Pump.fun virtual curve estimation
      effectiveLiquidityUsd = Math.max(5000, marketData.marketCap * 0.35);
    }

    const violations: string[] = [];

    // 1. Pool Liquidity Floor Check
    if (effectiveLiquidityUsd < CONFIG.MIN_LIQUIDITY_USD) {
      violations.push(
        `Likuiditas pool ($${effectiveLiquidityUsd.toFixed(0)}) di bawah batas minimum ($${CONFIG.MIN_LIQUIDITY_USD})`
      );
    }

    // 2. Minimum Market Cap Floor Check
    if (marketData.marketCap < CONFIG.MIN_MARKET_CAP_USD) {
      violations.push(
        `Market Cap ($${marketData.marketCap.toFixed(0)}) di bawah batas minimum ($${CONFIG.MIN_MARKET_CAP_USD})`
      );
    }

    const passed = violations.length === 0;

    // Score calculation (0 - 100 based on liquidity adequacy)
    const liquidityRatio = Math.min(effectiveLiquidityUsd / Math.max(1, CONFIG.MIN_LIQUIDITY_USD), 3.0);
    const score = passed ? Math.min(100, Math.round(50 + (liquidityRatio * 20))) : 20;

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed,
      action: passed ? 'ALLOW' : 'REJECT',
      score,
      weight: this.weight,
      reason: passed 
        ? `Likuiditas ($${effectiveLiquidityUsd.toFixed(0)}) dan MC ($${marketData.marketCap.toFixed(0)}) memenuhi standar institusional`
        : violations.join('; '),
      metricDetails: {
        effectiveLiquidityUsd,
        rawLiquidityUsd: marketData.liquidityUsd,
        marketCap: marketData.marketCap,
        minLiquidityRequired: CONFIG.MIN_LIQUIDITY_USD,
        minMarketCapRequired: CONFIG.MIN_MARKET_CAP_USD,
        isPumpFun
      }
    };
  }
}
