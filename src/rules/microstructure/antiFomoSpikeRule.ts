import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export class AntiFomoSpikeRule implements TradingRule {
  id = 'MICRO_ANTI_FOMO_SPIKE';
  name = 'Anti-FOMO Parabolic Spike Guard';
  description = 'Rejects orders chasing overextended vertical 5-minute candles to prevent catching the instant local top.';
  category = 'MICROSTRUCTURE' as const;
  isHardGate = true;
  weight = 8;

  evaluate(context: RuleContext): RuleResult {
    const { marketData } = context;

    if (!marketData || marketData.priceChange5m === undefined) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: false,
        passed: true,
        action: 'ALLOW',
        score: 75,
        weight: this.weight,
        reason: 'Metrik kenaikan 5-menit tidak tersedia, melewati filter FOMO spike'
      };
    }

    const spike5m = marketData.priceChange5m;
    const maxSpike = CONFIG.MAX_5M_PRICE_CHANGE_PCT;

    if (spike5m > maxSpike) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 20,
        weight: this.weight,
        reason: `Candle 5 menit terlalu overextended (+${spike5m.toFixed(1)}% > +${maxSpike}%). Rawan aksi profit taking / dump instan.`,
        metricDetails: { spike5m, maxAllowedSpike: maxSpike }
      };
    }

    const score = spike5m <= 0 ? 80 : Math.round(100 - (spike5m / maxSpike) * 30);

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed: true,
      action: 'ALLOW',
      score,
      weight: this.weight,
      reason: `Pergerakan 5 menit (+${spike5m.toFixed(1)}%) sehat dan tidak overextended`,
      metricDetails: { spike5m, maxAllowedSpike: maxSpike }
    };
  }
}
