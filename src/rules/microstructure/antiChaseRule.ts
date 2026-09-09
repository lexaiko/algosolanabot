import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export class AntiChaseRule implements TradingRule {
  id = 'MICRO_ANTI_CHASE';
  name = 'Anti-Chase Price Drift Guard (Pucuk Guard)';
  description = 'Rejects orders where the current market price has already drifted higher than the whale entry price.';
  category = 'MICROSTRUCTURE' as const;
  isHardGate = true;
  weight = 9;

  evaluate(context: RuleContext): RuleResult {
    const { marketData, whaleEntryPriceUsd } = context;

    if (!marketData || !whaleEntryPriceUsd || whaleEntryPriceUsd <= 0) {
      // Manual buy or whale entry price not tracked: pass with neutral score
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: false,
        passed: true,
        action: 'ALLOW',
        score: 75,
        weight: this.weight,
        reason: 'Tidak ada data pembanding whale entry (order manual atau first discovery)'
      };
    }

    const currentPrice = marketData.priceUsd;
    const driftPct = ((currentPrice - whaleEntryPriceUsd) / whaleEntryPriceUsd) * 100;
    const maxDrift = CONFIG.MAX_PRICE_DRIFT_PCT;

    if (driftPct > maxDrift) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 15,
        weight: this.weight,
        reason: `Pucuk Guard Aktif! Harga pasar sudah naik +${driftPct.toFixed(1)}% dari entry paus (Maks toleransi: +${maxDrift}%). Menghindari exit liquidity!`,
        metricDetails: {
          currentPrice,
          whaleEntryPriceUsd,
          driftPct,
          maxAllowedDrift: maxDrift
        }
      };
    }

    // Good entry timing: price is at or very close to whale entry (or even slightly lower on pullbacks)
    const score = driftPct <= 0 ? 100 : Math.max(60, Math.round(100 - (driftPct / maxDrift) * 35));

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed: true,
      action: 'ALLOW',
      score,
      weight: this.weight,
      reason: `Entry timing prima: drift harga +${driftPct.toFixed(1)}% masih dalam batas toleransi (+${maxDrift}%)`,
      metricDetails: {
        currentPrice,
        whaleEntryPriceUsd,
        driftPct,
        maxAllowedDrift: maxDrift
      }
    };
  }
}
