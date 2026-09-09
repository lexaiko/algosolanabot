import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export interface SizingComputationResult {
  allocatedSol: number;
  kellyFraction: number;
  rawKelly: number;
  winRate: number;
  payoffRatio: number;
  liquidityCapSol: number;
  targetTpPct: number;
  targetSlPct: number;
  rationale: string;
}

export class DynamicKellySizingRule implements TradingRule {
  id = 'RISK_DYNAMIC_KELLY_SIZING';
  name = 'Fractional Kelly Sizing & Liquidity Depth Cap';
  description = 'Computes optimal position size via fractional Kelly math and caps allocation to pool depth.';
  category = 'RISK' as const;
  isHardGate = false;
  weight = 9;

  evaluate(context: RuleContext): RuleResult {
    const { whale, marketData, solPriceUsd, portfolioBalanceSol, bondingCurveData } = context;

    const baseBuyAmount = whale?.tier === 'VIP' ? CONFIG.VIP_BUY_AMOUNT_SOL : CONFIG.DEFAULT_BUY_AMOUNT_SOL;

    if (!CONFIG.KELLY_SIZING_ENABLED || !whale) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: false,
        passed: true,
        action: 'ALLOW',
        score: 80,
        weight: this.weight,
        reason: 'Menggunakan sizing tier standar (Kelly sizing dinonaktifkan atau manual buy)',
        metricDetails: {
          allocatedSol: baseBuyAmount,
          targetTpPct: CONFIG.TAKE_PROFIT_PCT,
          targetSlPct: CONFIG.STOP_LOSS_PCT
        }
      };
    }

    // 1. Determine Win Rate (p) based on historical performance
    let winRate = 0.52;
    if (whale.total_trades_copied && whale.total_trades_copied >= 2 && whale.win_rate !== undefined) {
      winRate = Math.min(Math.max(whale.win_rate / 100, 0.35), 0.85);
    } else if (whale.tier === 'VIP') {
      winRate = 0.58;
    } else if (whale.tier === 'VERIFIED') {
      winRate = 0.54;
    }

    // Consecutive loss dampener: if whale is in a drawdown streak, reduce conviction
    if (whale.consecutive_losses && whale.consecutive_losses > 0) {
      winRate = Math.max(0.35, winRate - (whale.consecutive_losses * 0.08));
    }

    const p = winRate;
    const q = 1 - p;

    // 2. Payoff Ratio (b)
    const avgWinPct = CONFIG.TAKE_PROFIT_PCT || 42.0;
    const avgLossPct = CONFIG.STOP_LOSS_PCT || 14.0;
    const b = Math.max(1.2, avgWinPct / avgLossPct);

    // 3. Raw Kelly Criterion: f* = (p * b - q) / b
    const rawKelly = (p * b - q) / b;

    if (rawKelly <= 0) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: true,
        passed: false,
        action: 'REJECT',
        score: 20,
        weight: this.weight,
        reason: `Ekspektasi Matematis Negatif! Kelly f* (${(rawKelly * 100).toFixed(1)}%) mengindikasikan edge negatif (WR: ${(winRate * 100).toFixed(0)}%, Streak Loss: ${whale.consecutive_losses || 0}). Order dibatalkan demi melindungi modal.`,
        metricDetails: { rawKelly, winRate, b }
      };
    }

    // 4. Fractional Kelly Sizing (e.g. 0.25x for extreme drawdown resistance)
    const kellyFraction = CONFIG.KELLY_FRACTION || 0.25;
    const targetPortfolioPct = rawKelly * kellyFraction;
    let computedSol = portfolioBalanceSol * targetPortfolioPct;

    // Bound sizing within sane ranges [min 0.05 SOL, max 0.5 SOL or 2.5x base]
    const minSol = 0.05;
    const maxSol = Math.min(portfolioBalanceSol * 0.15, baseBuyAmount * 2.5);
    computedSol = Math.max(minSol, Math.min(computedSol, maxSol));

    // 5. Liquidity Depth Sizing Cap (Never exceed 1.5% of pool depth to prevent slippage)
    let effectivePoolUsd = marketData?.liquidityUsd || 0;
    if (bondingCurveData && bondingCurveData.liquiditySol > 0 && solPriceUsd > 0) {
      effectivePoolUsd = Math.max(effectivePoolUsd, bondingCurveData.liquiditySol * solPriceUsd);
    }

    let liquidityCapSol = 999;
    if (effectivePoolUsd > 0 && solPriceUsd > 0) {
      const maxPoolPct = (CONFIG.MAX_LIQUIDITY_DEPTH_PCT || 1.5) / 100;
      const maxTradeUsd = effectivePoolUsd * maxPoolPct;
      liquidityCapSol = Math.max(0.04, maxTradeUsd / solPriceUsd);
    }

    const finalAllocatedSol = Math.min(computedSol, liquidityCapSol);

    // 6. Volatility-Adaptive SL / TP
    let targetTpPct = CONFIG.TAKE_PROFIT_PCT;
    let targetSlPct = CONFIG.STOP_LOSS_PCT;
    if (CONFIG.VOLATILITY_ADAPTIVE_EXITS && marketData?.priceChange5m) {
      const absVol = Math.abs(marketData.priceChange5m);
      if (absVol > 12) {
        // High volatility token: widen stops slightly to prevent premature shakeout
        targetTpPct = Math.round(targetTpPct * 1.25);
        targetSlPct = Math.round(targetSlPct * 1.2);
      }
    }

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: false,
      passed: true,
      action: 'ALLOW',
      score: Math.min(100, Math.round(60 + rawKelly * 60)),
      weight: this.weight,
      reason: `Alokasi Kelly ${finalAllocatedSol.toFixed(3)} SOL dihitung matematis (WR: ${(winRate * 100).toFixed(0)}%, Kelly: ${(rawKelly * 100).toFixed(1)}%)`,
      metricDetails: {
        allocatedSol: Number(finalAllocatedSol.toFixed(4)),
        rawKelly: Number(rawKelly.toFixed(4)),
        winRate: Number(winRate.toFixed(3)),
        payoffRatio: Number(b.toFixed(2)),
        liquidityCapSol: Number(liquidityCapSol.toFixed(4)),
        targetTpPct,
        targetSlPct
      }
    };
  }
}
