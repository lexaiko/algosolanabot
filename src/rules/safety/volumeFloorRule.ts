import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export class VolumeFloorRule implements TradingRule {
  id = 'SAFETY_VOLUME_FLOOR';
  name = '24h Volume Active Market Depth Gate';
  description = 'Ensures trading activity exists so orders can be exited without causing massive price collapse.';
  category = 'SAFETY' as const;
  isHardGate = true;
  weight = 7;

  evaluate(context: RuleContext): RuleResult {
    const { marketData, tokenAddress } = context;

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
        reason: `Data volume tidak ditemukan untuk token ${tokenAddress}`
      };
    }

    const volume24h = marketData.volume24h ?? 0;
    const minVolume = CONFIG.MIN_VOLUME_24H_USD;

    // If volume is present and below floor
    if (volume24h > 0 && volume24h < minVolume) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: Math.max(10, Math.round((volume24h / minVolume) * 40)),
        weight: this.weight,
        reason: `Volume 24 jam ($${volume24h.toLocaleString()}) di bawah batas minimum ($${minVolume.toLocaleString()}) - Risiko Zombie Token`,
        metricDetails: { volume24h, minVolume }
      };
    }

    const volumeRatio = Math.min(volume24h / Math.max(1, minVolume), 5.0);
    const score = Math.min(100, Math.round(50 + (volumeRatio * 10)));

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed: true,
      action: 'ALLOW',
      score,
      weight: this.weight,
      reason: `Volume 24 jam ($${volume24h.toLocaleString()}) aktif dan memenuhi standar market depth`,
      metricDetails: { volume24h, minVolume }
    };
  }
}
