import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export class CabalClusterRule implements TradingRule {
  id = 'MICRO_CABAL_CLUSTER';
  name = 'Cabal & Sybil Bundle Forensic Shield';
  description = 'Detects dev insider bundling, multi-wallet sybils, and coordinated cabal dumps via on-chain funder clustering.';
  category = 'MICROSTRUCTURE' as const;
  isHardGate = true;
  weight = 9;

  evaluate(context: RuleContext): RuleResult {
    if (!CONFIG.CABAL_SHIELD_ENABLED) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: false,
        passed: true,
        action: 'ALLOW',
        score: 70,
        weight: this.weight,
        reason: 'Cabal shield dinonaktifkan dalam konfigurasi'
      };
    }

    const { cabalData, whale } = context;

    if (cabalData && cabalData.isCabal) {
      const clusterCount = cabalData.clusteredWhaleCount || 0;
      const funder = cabalData.sharedFunder ? `(Funder: ${cabalData.sharedFunder.slice(0, 8)}...)` : '';
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 10,
        weight: this.weight,
        reason: `Terdeteksi Cabal Cluster! ${clusterCount} wallet terafiliasi dari funder yang sama ${funder}. Potensi skema wash trading / synchronized dump.`,
        metricDetails: { cabalData }
      };
    }

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed: true,
      action: 'ALLOW',
      score: 90,
      weight: this.weight,
      reason: 'Wallet & token lolos verifikasi forensik cabal (tidak ada jejak cluster sybil terdeteksi)',
      metricDetails: { whaleAddress: whale?.address, cabalData }
    };
  }
}
