import { RuleContext, RuleResult, TradingRule } from '../types';

export class BondingCurveRule implements TradingRule {
  id = 'MICRO_BONDING_CURVE';
  name = 'Bonding Curve Microstructure Gate';
  description = 'Evaluates Pump.fun bonding curve completion and migration transition risks.';
  category = 'MICROSTRUCTURE' as const;
  isHardGate = false;
  weight = 7;

  evaluate(context: RuleContext): RuleResult {
    const { tokenAddress, bondingCurveData } = context;

    const isPumpFun = tokenAddress.endsWith('pump');
    if (!isPumpFun || !bondingCurveData) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: false,
        passed: true,
        action: 'ALLOW',
        score: 80,
        weight: this.weight,
        reason: 'Token berada di AMM pool standar (Raydium/Orca) atau kurva bonding tidak aktif'
      };
    }

    const { complete, progressPct, spotPriceSol, liquiditySol } = bondingCurveData;

    // Danger Zone: 96% - 99.9% progress is the "Migration Trap" where liquidity migration freezes trading
    if (!complete && progressPct >= 96.0) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: true,
        passed: false,
        action: 'REJECT',
        score: 15,
        weight: this.weight,
        reason: `Kurva bonding di zona bahaya migrasi (${progressPct.toFixed(1)}%). Transaksi berisiko gagal saat migrasi likuiditas ke Raydium.`,
        metricDetails: { progressPct, complete, spotPriceSol, liquiditySol }
      };
    }

    // Healthy bonding curve progression (e.g. 15% - 85%)
    let score = 85;
    if (progressPct >= 20 && progressPct <= 75) {
      score = 95; // Sweet spot for organic curve momentum
    } else if (progressPct < 5) {
      score = 70; // Extremely nascent, high volatility
    }

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: false,
      passed: true,
      action: 'ALLOW',
      score,
      weight: this.weight,
      reason: `Progres bonding curve (${progressPct.toFixed(1)}%) sehat dan memiliki likuiditas virtual (${liquiditySol.toFixed(2)} SOL)`,
      metricDetails: { progressPct, complete, spotPriceSol, liquiditySol }
    };
  }
}
