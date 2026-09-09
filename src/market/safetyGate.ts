import { RugCheckResult } from '../types/index';
import { CONFIG } from '../config';

export interface SafetyAuditResult {
  allowed: boolean;
  hardBlocked: boolean;
  riskScore: number; // 0 (Prism safe) to 100 (Deadly/toxic)
  hardViolations: string[];
  softPenalties: Record<string, number>;
  details: {
    mintRevoked: boolean;
    freezeRevoked: boolean;
    lpLocked: boolean;
    top10Pct: number;
    cabalSuspect: boolean;
  };
}

export class SafetyGate {
  /**
   * Deterministically evaluates token contract and wallet forensics.
   * Hard blocks immediately disqualify the candidate.
   */
  public evaluateTokenSafety(params: {
    tokenAddress: string;
    safetyReport?: RugCheckResult | null;
    isCabalSuspect?: boolean;
    liquidityUsd: number;
    marketCapUsd: number;
  }): SafetyAuditResult {
    const { tokenAddress, safetyReport, isCabalSuspect, liquidityUsd, marketCapUsd } = params;
    const hardViolations: string[] = [];
    const softPenalties: Record<string, number> = {};
    let calculatedRiskScore = 15; // Baseline pristine score

    const isPumpFun = tokenAddress.endsWith('pump');

    // 1. HARD BLOCK: Cabal Sybil Cluster Check
    if (isCabalSuspect) {
      hardViolations.push('CABAL_SYBIL_BUNDLE_DETECTED');
      calculatedRiskScore = 100;
    }

    // 2. HARD BLOCK: Contract Safety from RugCheck
    if (safetyReport) {
      if (CONFIG.REQUIRE_MINT_REVOKED && !safetyReport.mintAuthorityRevoked) {
        hardViolations.push('MINT_AUTHORITY_ACTIVE');
        calculatedRiskScore = 100;
      }
      if (CONFIG.REQUIRE_FREEZE_REVOKED && !safetyReport.freezeAuthorityRevoked) {
        hardViolations.push('FREEZE_AUTHORITY_ACTIVE');
        calculatedRiskScore = 100;
      }
      if (!isPumpFun && CONFIG.REQUIRE_LP_BURNED && !safetyReport.lpBurnedOrLocked) {
        hardViolations.push('LP_NOT_LOCKED_OR_BURNED');
        calculatedRiskScore = 100;
      }
      if (safetyReport.top10HoldersPct > CONFIG.MAX_TOP10_HOLDERS_PCT) {
        hardViolations.push(`TOP_HOLDERS_CONCENTRATION_EXCEEDED_${safetyReport.top10HoldersPct.toFixed(0)}%`);
        calculatedRiskScore = 100;
      }
      if (safetyReport.score < CONFIG.MIN_RUGCHECK_SCORE) {
        hardViolations.push(`RUGCHECK_SCORE_CRITICAL_${safetyReport.score}`);
        calculatedRiskScore = 100;
      }
    } else {
      // Missing report is a hard block in institutional mode
      hardViolations.push('AUDIT_REPORT_UNAVAILABLE');
      calculatedRiskScore = 95;
    }

    // 3. HARD BLOCK: Liquidity Floor
    const minLiquidity = CONFIG.MIN_LIQUIDITY_USD || 6000;
    if (liquidityUsd < minLiquidity) {
      hardViolations.push(`LIQUIDITY_SUB_FLOOR_$${liquidityUsd.toFixed(0)}`);
      calculatedRiskScore = 100;
    }

    // 4. SOFT PENALTIES (When no hard block has failed)
    if (hardViolations.length === 0 && safetyReport) {
      if (safetyReport.top10HoldersPct > 35) {
        softPenalties['MODERATE_CONCENTRATION'] = 15;
        calculatedRiskScore += 15;
      }
      if (liquidityUsd < minLiquidity * 1.5) {
        softPenalties['LOW_BUFFER_LIQUIDITY'] = 10;
        calculatedRiskScore += 10;
      }
      if (marketCapUsd < (CONFIG.MIN_MARKET_CAP_USD || 15000) * 1.5) {
        softPenalties['MICRO_CAP_VOLATILITY'] = 10;
        calculatedRiskScore += 10;
      }
    }

    const hardBlocked = hardViolations.length > 0;
    const allowed = !hardBlocked && calculatedRiskScore <= 60;

    return {
      allowed,
      hardBlocked,
      riskScore: Math.min(100, calculatedRiskScore),
      hardViolations,
      softPenalties,
      details: {
        mintRevoked: safetyReport?.mintAuthorityRevoked ?? false,
        freezeRevoked: safetyReport?.freezeAuthorityRevoked ?? false,
        lpLocked: safetyReport?.lpBurnedOrLocked ?? false,
        top10Pct: safetyReport?.top10HoldersPct ?? 0,
        cabalSuspect: !!isCabalSuspect
      }
    };
  }
}

export const safetyGate = new SafetyGate();
