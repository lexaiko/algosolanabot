import { FeatureVector, StrategySignal, EntryLifecycleState } from '../core/types';
import { OpportunityScorer, opportunityScorer } from './opportunityScorer';
import { adaptiveLearningEngine } from '../strategies/adaptiveLearningEngine';
import { CONFIG } from '../config';

export interface EntryDecisionResult {
  shouldEnter: boolean;
  state: EntryLifecycleState;
  compositeScore: number;
  reason: string;
  explanation: string;
  invalidationReason?: string;
}

export class EntryEngine {
  private scorer: OpportunityScorer;

  constructor(scorer: OpportunityScorer = opportunityScorer) {
    this.scorer = scorer;
  }

  /**
   * Evaluates entry quality through progressive finite state machine verification,
   * dynamically driven by the Adaptive Learning Engine's hurdle rate.
   */
  public evaluateEntryTiming(features: FeatureVector, signals: StrategySignal[]): EntryDecisionResult {
    const scoreResult = this.scorer.scoreOpportunity(features, signals);
    const score = scoreResult.compositeScore;
    const dynamicMinScore = adaptiveLearningEngine.getMinEntryScore();
    const watchingThreshold = Math.max(40, dynamicMinScore - 18);

    // STAGE 1: IMMEDIATE INVALIDATION GATES (Fail-Fast)
    // Invalidation 1: Parabolic overextension
    const maxReturnPct = CONFIG.MAX_5M_PRICE_CHANGE_PCT || 50.0;
    if (features.return5m > maxReturnPct) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Candle 5 menit overextended (+${features.return5m.toFixed(1)}% > ${maxReturnPct}%), setup di-invalidasi untuk mencegah pucuk trap`,
        explanation: scoreResult.explanation,
        invalidationReason: 'PARABOLIC_5M_OVEREXTENDED'
      };
    }

    // Invalidation 2: Order Flow Dominance (OFD) Check - Sells dominant or balanced churn (AICAT trap prevention)
    if (features.buySellRatio < 1.35 || features.flowImbalance < 0.15) {
      return {
        shouldEnter: false,
        state: 'WATCHING',
        compositeScore: score,
        reason: `Order flow belum dominan buy (Buy/Sell: ${features.buySellRatio.toFixed(2)}x < 1.35x, Imbalance: ${(features.flowImbalance * 100).toFixed(0)}%). Aksi saling banting terdeteksi`,
        explanation: scoreResult.explanation,
        invalidationReason: 'CHURN_FLOW_LACKS_BUY_DOMINANCE'
      };
    }

    // Invalidation 3: Falling Knife / Deep Dump Guard
    if (features.drawdownFromPeakPct > 8.0) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Penurunan dari puncak terlalu dalam (-${features.drawdownFromPeakPct.toFixed(1)}% > 8.0%), terdeteksi pisau jatuh / dump in progress`,
        explanation: scoreResult.explanation,
        invalidationReason: 'FALLING_KNIFE_DUMP_IN_PROGRESS'
      };
    }

    // Invalidation 3b: Upper Wick Rejection Guard (Pucuk Guard / Anti-Distribution)
    // Rejects parabolic coins if the 5m candle has a long upper wick (> 40% of body)
    // which signals dev/insider selling into strength / top-wick distribution!
    const upperWickRatio = features.upperWickRatio !== undefined ? features.upperWickRatio : (
      features.return5m > 0 && features.drawdownFromPeakPct > 0 
        ? ((features.drawdownFromPeakPct / 100) / Math.max(0.01, 1 - features.drawdownFromPeakPct / 100)) / Math.max(0.01, features.return5m / (100 + features.return5m))
        : (features.drawdownFromPeakPct > 3.0 ? 999.0 : 0)
    );

    if (upperWickRatio > 0.40) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Jarum atas candle terlalu panjang (Upper Wick ${(upperWickRatio * 100).toFixed(0)}% > 40% dari body). Dev/insider terdeteksi jualan di pucuk (Distribution Phase)`,
        explanation: scoreResult.explanation,
        invalidationReason: 'UPPER_WICK_DISTRIBUTION_REJECTION'
      };
    }

    // Invalidation 4: Dual-Engine Entry - Parabolic Breakout vs Top-Tick Pucuk Trap
    // If token is in a genuine Parabolic Breakout (Volume shock >= 1.8x, heavy buy dominance >= 1.75x, positive whale flow),
    // it is ALLOWED to enter directly at the peak because momentum is violently expanding!
    const isParabolicBreakout = (features.volumeAcceleration >= 1.8 || features.volume5mUsd >= 50000) &&
      features.buySellRatio >= 1.75 &&
      features.flowImbalance >= 0.20 &&
      (features.whaleNetFlowSol >= 1.0 || features.smartMoneyAccumulationScore >= 70);

    if (features.return5m > 8.0 && features.drawdownFromPeakPct < 1.5 && !isParabolicBreakout) {
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Harga menempel di puncak candle (+${features.return5m.toFixed(1)}%) tanpa konfirmasi volume shock. Menunggu pullback sehat (-2% s/d -6%) untuk konfirmasi absorpsi`,
        explanation: scoreResult.explanation,
        invalidationReason: 'TOP_TICK_FOMO_GUARD'
      };
    }

    // Invalidation 5: Absorption Rebound Verification - Never buy while 1m tick is dropping!
    if (features.drawdownFromPeakPct >= 2.0 && features.return1m <= -0.5 && !isParabolicBreakout) {
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Pullback sedang berlangsung (-${features.drawdownFromPeakPct.toFixed(1)}%), namun tick 1m masih merah. Dilarang menangkap pisau jatuh sebelum ada pantulan hijau`,
        explanation: scoreResult.explanation,
        invalidationReason: 'AWAITING_GREEN_REBOUND_TICK'
      };
    }

    // Invalidation 6: Poor execution economics (estimated impact > 3.5%)
    if (features.estimatedPriceImpactPct > 3.5) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Biaya slippage & impact pool terlalu tinggi (${features.estimatedPriceImpactPct.toFixed(1)}% > 3.5%), rasio payoff tidak ekonomis`,
        explanation: scoreResult.explanation,
        invalidationReason: 'EXCESSIVE_SLIPPAGE_IMPACT'
      };
    }

    // STAGE 2: WATCHING
    if (signals.length === 0 || score < watchingThreshold) {
      return {
        shouldEnter: false,
        state: 'WATCHING',
        compositeScore: score,
        reason: `Sinyal strategi belum terbentuk atau skor di bawah ambang batas dasar (${watchingThreshold})`,
        explanation: scoreResult.explanation
      };
    }

    // STAGE 3: SETUP_FORMING
    if (score < dynamicMinScore) {
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Setup terdeteksi (${signals.map(s => s.strategyName).join(', ')}), menunggu konfirmasi skor adaptif (Skor saat ini: ${score}/100, Butuh: >=${dynamicMinScore})`,
        explanation: scoreResult.explanation
      };
    }

    // STAGE 4: CONFIRMED & ENTRY
    const entryMode = isParabolicBreakout ? 'PARABOLIC_BREAKOUT' : 'PULLBACK_ABSORPTION';
    return {
      shouldEnter: true,
      state: 'ENTRY',
      compositeScore: score,
      reason: `Setup terkonfirmasi [${entryMode}]: skor ${score}/100 didukung ${signals.length} strategi (${signals.map(s => s.strategyName).join(', ')})`,
      explanation: scoreResult.explanation
    };
  }
}

export const entryEngine = new EntryEngine();
