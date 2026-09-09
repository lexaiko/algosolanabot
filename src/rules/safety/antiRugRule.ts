import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export class AntiRugRule implements TradingRule {
  id = 'SAFETY_ANTI_RUG';
  name = 'Anti-Rug Contract Security Gate';
  description = 'Verifies mint authority revocation, freeze authority, LP lock/burn status, and RugCheck risk score.';
  category = 'SAFETY' as const;
  isHardGate = true;
  weight = 10;

  evaluate(context: RuleContext): RuleResult {
    const { safetyData, tokenAddress } = context;

    // If safety report is missing
    if (!safetyData) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 0,
        weight: this.weight,
        reason: `Data audit keamanan (RugCheck) tidak tersedia untuk token ${tokenAddress}`,
        metricDetails: { tokenAddress, hasSafetyData: false }
      };
    }

    const violations: string[] = [];

    // 1. Mint Authority Revocation
    if (CONFIG.REQUIRE_MINT_REVOKED && !safetyData.mintAuthorityRevoked) {
      violations.push('Mint Authority aktif (Dev bisa mencetak token tak terbatas)');
    }

    // 2. Freeze Authority Revocation
    if (CONFIG.REQUIRE_FREEZE_REVOKED && !safetyData.freezeAuthorityRevoked) {
      violations.push('Freeze Authority aktif (Dev bisa membekukan wallet pembeli / honeypot)');
    }

    // 3. LP Status (for Raydium / graduated DEX pools)
    const isPumpFun = tokenAddress.endsWith('pump');
    if (!isPumpFun && CONFIG.REQUIRE_LP_BURNED && !safetyData.lpBurnedOrLocked) {
      violations.push('Likuiditas LP belum dibakar/dikunci (Rawan rugpull liquidity drain)');
    }

    // 4. Top 10 Holders Concentration
    if (safetyData.top10HoldersPct > CONFIG.MAX_TOP10_HOLDERS_PCT) {
      violations.push(`Konsentrasi Top 10 Holders ${safetyData.top10HoldersPct.toFixed(1)}% melebihi batas aman (${CONFIG.MAX_TOP10_HOLDERS_PCT}%)`);
    }

    // 5. Overall RugCheck Score Threshold
    if (safetyData.score < CONFIG.MIN_RUGCHECK_SCORE) {
      violations.push(`Skor RugCheck ${safetyData.score}/100 berada di bawah batas minimum (${CONFIG.MIN_RUGCHECK_SCORE})`);
    }

    const passed = violations.length === 0;

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed,
      action: passed ? 'ALLOW' : 'REJECT',
      score: safetyData.score,
      weight: this.weight,
      reason: passed ? 'Kontrak token lolos seluruh verifikasi anti-rug & keamanan on-chain' : violations.join('; '),
      metricDetails: {
        score: safetyData.score,
        mintAuthorityRevoked: safetyData.mintAuthorityRevoked,
        freezeAuthorityRevoked: safetyData.freezeAuthorityRevoked,
        lpBurnedOrLocked: safetyData.lpBurnedOrLocked,
        top10HoldersPct: safetyData.top10HoldersPct,
        violations
      }
    };
  }
}
