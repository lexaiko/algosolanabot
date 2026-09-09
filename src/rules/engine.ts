import { CONFIG } from '../config';
import { 
  RuleContext, 
  RuleResult, 
  TradingRule, 
  BuyEvaluationResult, 
  ExitEvaluationContext, 
  ExitEvaluationResult 
} from './types';

// Safety Gates
import { AntiRugRule } from './safety/antiRugRule';
import { LiquidityFloorRule } from './safety/liquidityFloorRule';
import { VolumeFloorRule } from './safety/volumeFloorRule';

// Microstructure Rules
import { CabalClusterRule } from './microstructure/cabalClusterRule';
import { AntiChaseRule } from './microstructure/antiChaseRule';
import { AntiFomoSpikeRule } from './microstructure/antiFomoSpikeRule';
import { BondingCurveRule } from './microstructure/bondingCurveRule';

// Risk & Sizing Rules
import { PortfolioExposureRule } from './risk/portfolioExposureRule';
import { NarrativeLimitRule, parseTokenNarrative } from './risk/narrativeLimitRule';
import { DynamicKellySizingRule } from './risk/dynamicKellySizing';

// Exit Rules
import { FlashExitShieldRule } from './exit/flashExitShield';
import { WhaleDumpRule } from './exit/whaleDumpRule';
import { DynamicTrailingStopRule } from './exit/dynamicTrailingStop';
import { TimeDecayExitRule } from './exit/timeDecayExitRule';

export class AdvancedRuleEngine {
  private buyRules: TradingRule[] = [];
  private exitRules = {
    flashShield: new FlashExitShieldRule(),
    whaleDump: new WhaleDumpRule(),
    trailingStop: new DynamicTrailingStopRule(),
    timeDecay: new TimeDecayExitRule()
  };

  constructor() {
    this.registerDefaultRules();
  }

  /**
   * Registers default quantitative rules in logical priority order
   */
  private registerDefaultRules() {
    // 1. Hard Security Gates
    this.registerRule(new AntiRugRule());
    this.registerRule(new LiquidityFloorRule());
    this.registerRule(new VolumeFloorRule());

    // 2. Portfolio Risk & Exposure Gates
    this.registerRule(new PortfolioExposureRule());
    this.registerRule(new NarrativeLimitRule());

    // 3. On-Chain Microstructure & Timing
    this.registerRule(new CabalClusterRule());
    this.registerRule(new AntiChaseRule());
    this.registerRule(new AntiFomoSpikeRule());
    this.registerRule(new BondingCurveRule());

    // 4. Mathematical Sizing & Capital Allocation
    this.registerRule(new DynamicKellySizingRule());
  }

  public registerRule(rule: TradingRule): void {
    this.buyRules.push(rule);
  }

  public getRules(): TradingRule[] {
    return [...this.buyRules];
  }

  /**
   * Master Buy Pipeline: Multi-Stage Quantitative Evaluation
   */
  public async evaluateBuy(context: RuleContext): Promise<BuyEvaluationResult> {
    const hardGateRules = this.buyRules.filter(r => r.isHardGate);
    const softRules = this.buyRules.filter(r => !r.isHardGate);

    const ruleAuditTrail: RuleResult[] = [];
    const passedRules: string[] = [];
    const rejectionReasons: string[] = [];
    const warnings: string[] = [];

    // ==========================================
    // STAGE 1: HARD GATES (FAIL-FAST EXECUTION)
    // ==========================================
    for (const rule of hardGateRules) {
      const result = await rule.evaluate(context);
      ruleAuditTrail.push(result);

      if (!result.passed || result.action === 'REJECT') {
        rejectionReasons.push(`[${rule.name}] ${result.reason || 'Kriteria gagal dipenuhi'}`);

        return {
          allowed: false,
          compositeScore: result.score,
          allocatedSol: 0,
          targetTpPct: CONFIG.TAKE_PROFIT_PCT,
          targetSlPct: CONFIG.STOP_LOSS_PCT,
          hardGateFailed: result,
          rejectionReasons,
          warnings,
          passedRules,
          ruleAuditTrail,
          executionPlan: {
            recommendedTipLamports: CONFIG.JITO_TIP_LAMPORTS,
            useJitoBundle: CONFIG.JITO_MEV_ENABLED,
            narrative: 'REJECTED'
          }
        };
      }

      passedRules.push(rule.id);
    }

    // ==========================================
    // STAGE 2: SOFT RULES & COMPOSITE SCORING
    // ==========================================
    let totalScoreWeight = 0;
    let weightedScoreSum = 0;

    // Include hard gate scores in composite calculation
    for (const res of ruleAuditTrail) {
      weightedScoreSum += res.score * res.weight;
      totalScoreWeight += res.weight;
    }

    for (const rule of softRules) {
      const result = await rule.evaluate(context);
      ruleAuditTrail.push(result);

      if (!result.passed && result.action === 'REJECT') {
        rejectionReasons.push(`[${rule.name}] ${result.reason}`);
      } else if (result.action === 'WARN') {
        warnings.push(`[${rule.name}] ${result.reason}`);
      } else {
        passedRules.push(rule.id);
      }

      weightedScoreSum += result.score * rule.weight;
      totalScoreWeight += rule.weight;
    }

    const compositeScore = totalScoreWeight > 0 
      ? Math.round(weightedScoreSum / totalScoreWeight) 
      : 75;

    // Minimum composite score threshold (e.g. 60/100)
    const minAcceptableScore = 60;
    if (compositeScore < minAcceptableScore && rejectionReasons.length === 0) {
      rejectionReasons.push(`Skor komposit rule-based (${compositeScore}/100) di bawah ambang batas minimum (${minAcceptableScore})`);
    }

    // ==========================================
    // STAGE 3: SIZING & EXECUTION PARAMETERS
    // ==========================================
    const kellyAudit = ruleAuditTrail.find(r => r.ruleId === 'RISK_DYNAMIC_KELLY_SIZING');
    let allocatedSol = kellyAudit?.metricDetails?.allocatedSol || CONFIG.DEFAULT_BUY_AMOUNT_SOL;
    let targetTpPct = kellyAudit?.metricDetails?.targetTpPct || CONFIG.TAKE_PROFIT_PCT;
    let targetSlPct = kellyAudit?.metricDetails?.targetSlPct || CONFIG.STOP_LOSS_PCT;

    // Narrative tagging
    const symbol = context.marketData?.symbol || '';
    const name = context.marketData?.name || '';
    const narrative = parseTokenNarrative(symbol, name);

    // Dynamic Jito Tip calculation (higher conviction = higher validator tip to guarantee placement)
    let recommendedTipLamports = CONFIG.JITO_TIP_LAMPORTS;
    if (compositeScore >= 85 && context.whale?.tier === 'VIP') {
      recommendedTipLamports = Math.round(CONFIG.JITO_TIP_LAMPORTS * 1.5);
    }

    const allowed = rejectionReasons.length === 0;

    return {
      allowed,
      compositeScore,
      allocatedSol: allowed ? allocatedSol : 0,
      targetTpPct,
      targetSlPct,
      rejectionReasons,
      warnings,
      passedRules,
      ruleAuditTrail,
      executionPlan: {
        recommendedTipLamports,
        useJitoBundle: CONFIG.JITO_MEV_ENABLED,
        narrative
      }
    };
  }

  /**
   * Master Exit Pipeline: Evaluates active positions every tick
   */
  public evaluateExit(context: ExitEvaluationContext): ExitEvaluationResult {
    // 1. Emergency Flash Liquidity Exit (Highest Urgency)
    const flashExit = this.exitRules.flashShield.evaluate(context);
    if (flashExit && flashExit.shouldExit) return flashExit;

    // 2. Whale Exit Synchronization (Copy Sell)
    const whaleExit = this.exitRules.whaleDump.evaluate(context);
    if (whaleExit && whaleExit.shouldExit) return whaleExit;

    // 3. Dynamic Trailing Stop & Multi-Tier TP
    const trailingExit = this.exitRules.trailingStop.evaluate(context);
    if (trailingExit && trailingExit.shouldExit) return trailingExit;

    // 4. Time-Decay Stagnant Position Reaper
    const timeDecayExit = this.exitRules.timeDecay.evaluate(context);
    if (timeDecayExit && timeDecayExit.shouldExit) return timeDecayExit;

    return {
      shouldExit: false,
      action: 'HOLD',
      reason: 'Semua metrik posisi dalam parameter aman (HOLD)',
      currentPnlPct: context.position.pnl_pct
    };
  }
}

// Global Singleton Instance
export const ruleEngine = new AdvancedRuleEngine();
