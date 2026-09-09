import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export class PortfolioExposureRule implements TradingRule {
  id = 'RISK_PORTFOLIO_EXPOSURE';
  name = 'Portfolio Capacity & Cash Buffer Gate';
  description = 'Guarantees portfolio diversification limits and ensures cash reserves are not depleted.';
  category = 'RISK' as const;
  isHardGate = true;
  weight = 9;

  evaluate(context: RuleContext): RuleResult {
    const { openPositions, portfolioBalanceSol } = context;

    // 1. Max Concurrent Open Positions
    const maxPositions = CONFIG.MAX_OPEN_POSITIONS;
    if (openPositions.length >= maxPositions) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 0,
        weight: this.weight,
        reason: `Kapasitas portofolio penuh (${openPositions.length}/${maxPositions} posisi aktif). Mempertahankan cadangan kas.`,
        metricDetails: { currentOpen: openPositions.length, maxPositions }
      };
    }

    // 2. Minimum SOL Cash Reserve (e.g. at least 0.05 SOL for network fees & rent)
    const minReserveSol = 0.05;
    if (portfolioBalanceSol < minReserveSol) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 0,
        weight: this.weight,
        reason: `Saldo kas (${portfolioBalanceSol.toFixed(4)} SOL) di bawah batas minimum reserve (${minReserveSol} SOL) untuk gas fee.`,
        metricDetails: { portfolioBalanceSol, minReserveSol }
      };
    }

    const utilizationRatio = openPositions.length / maxPositions;
    const score = Math.round(100 - (utilizationRatio * 40));

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed: true,
      action: 'ALLOW',
      score,
      weight: this.weight,
      reason: `Kapasitas portofolio aman (${openPositions.length}/${maxPositions} posisi) dengan kas ${portfolioBalanceSol.toFixed(3)} SOL`,
      metricDetails: { currentOpen: openPositions.length, maxPositions, portfolioBalanceSol }
    };
  }
}
