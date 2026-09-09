import { FeatureVector, StrategySignal, EntryLifecycleState } from '../core/types';
import { OpportunityScorer, opportunityScorer } from './opportunityScorer';

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
   * Evaluates entry quality through progressive finite state machine verification
   */
  public evaluateEntryTiming(features: FeatureVector, signals: StrategySignal[]): EntryDecisionResult {
    const scoreResult = this.scorer.scoreOpportunity(features, signals);
    const score = scoreResult.compositeScore;

    // STAGE 1: IMMEDIATE INVALIDATION GATES (Fail-Fast)
    // Invalidation 1: Parabolic overextension
    if (features.return5m > 22.0) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Candle 5 menit overextended (+${features.return5m.toFixed(1)}% > 22%), setup di-invalidasi untuk mencegah pucuk trap`,
        explanation: scoreResult.explanation,
        invalidationReason: 'PARABOLIC_5M_OVEREXTENDED'
      };
    }

    // Invalidation 2: Sudden flow collapse
    if (features.flowImbalance <= -0.1) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: 'Arus transaksi mendadak didominasi aksi jual, momentum dibatalkan',
        explanation: scoreResult.explanation,
        invalidationReason: 'SELL_FLOW_DOMINANCE'
      };
    }

    // Invalidation 3: Poor execution economics (estimated impact > 3.5%)
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
    if (signals.length === 0 || score < 50) {
      return {
        shouldEnter: false,
        state: 'WATCHING',
        compositeScore: score,
        reason: 'Sinyal strategi belum terbentuk atau skor di bawah ambang batas dasar (50)',
        explanation: scoreResult.explanation
      };
    }

    // STAGE 3: SETUP_FORMING
    if (score < 65) {
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Setup terdeteksi (${signals.map(s => s.strategyName).join(', ')}), menunggu konfirmasi skor (Skor saat ini: ${score}/100, Butuh: >=65)`,
        explanation: scoreResult.explanation
      };
    }

    // STAGE 4: CONFIRMED & ENTRY
    return {
      shouldEnter: true,
      state: 'ENTRY',
      compositeScore: score,
      reason: `Setup terkonfirmasi prima: skor ${score}/100 didukung ${signals.length} strategi (${signals.map(s => s.strategyName).join(', ')})`,
      explanation: scoreResult.explanation
    };
  }
}

export const entryEngine = new EntryEngine();
