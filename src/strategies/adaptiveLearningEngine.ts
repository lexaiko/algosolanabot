import {
  getLearnedParameter,
  setLearnedParameter,
  getAllLearnedParameters,
  getStrategyAttributionRecords,
  upsertStrategyAttributionRecord,
  StrategyAttributionRecord,
  db
} from '../db/index';

export interface ScoringWeights {
  momentumWeight: number;
  volumeWeight: number;
  flowWeight: number;
  liquidityWeight: number;
  buyPressureWeight: number;
  consensusBonus: number;
}

export interface DynamicTpSlTargets {
  targetTpPct: number;
  targetSlPct: number;
  trailingStopPct: number;
  bepTriggerPct: number;
  rrRatio: number;
}

export interface TradeOutcomeFeedback {
  positionId: number;
  tokenAddress: string;
  tokenSymbol: string;
  netPnlSol: number;
  pnlPct: number;
  reason: string;
  strategySource?: string;
  setupType?: string;
  entryScore?: number;
  entryRegime?: string;
  holdingDurationSeconds?: number;
}

// ---------------------------------------------------------------------------
// INSTITUTIONAL LEARNING POLICY
// A fund does not let 3 trades move its parameters. Hard rules:
//
// - Attribution is RECORDED from trade #1 (data is always valuable).
// - Entry-hurdle adaptation: only when total closed algo trades >= 30.
//   Moves capped at +/-2 pts per adaptation, hard-bounded to [68, 80].
// - Scorer component weights: FROZEN at priors until >= 200 attributed
//   trades. Online per-trade bandit updates on tiny samples are noise
//   chasing, not learning. Weights get fit OFFLINE from the decision log.
// - Stop-loss is NOT adapted. Hard SL = 9.5% constant. (The old "adaptive
//   SL" was theater: every adapted value was clamped straight back to 9.5.)
// ---------------------------------------------------------------------------
const MIN_TRADES_FOR_HURDLE_ADAPT = 30;
const MIN_TRADES_FOR_WEIGHT_ADAPT = 200;
const MAX_HURDLE_MOVE_PER_ADAPT = 2;
const MIN_ENTRY_SCORE_FLOOR = 68;
const MIN_ENTRY_SCORE_CAP = 80;
const HARD_SL_PCT = 9.5;

const DEFAULT_WEIGHTS: ScoringWeights = {
  momentumWeight: 20,
  volumeWeight: 20,
  flowWeight: 20,
  liquidityWeight: 20,
  buyPressureWeight: 15,
  consensusBonus: 10
};

export class AdaptiveLearningEngine {
  private weights: ScoringWeights = { ...DEFAULT_WEIGHTS };
  private minEntryScore: number = 75;
  private trailingStopPct: number = 12.0;
  private bepTriggerPct: number = 20.0;
  private sampleTradeCount: number = 0;

  constructor() {
    this.loadFromDatabase();
  }

  public loadFromDatabase(): void {
    try {
      this.weights.momentumWeight = getLearnedParameter('weight_momentum', DEFAULT_WEIGHTS.momentumWeight);
      this.weights.volumeWeight = getLearnedParameter('weight_volume', DEFAULT_WEIGHTS.volumeWeight);
      this.weights.flowWeight = getLearnedParameter('weight_flow', DEFAULT_WEIGHTS.flowWeight);
      this.weights.liquidityWeight = getLearnedParameter('weight_liquidity', DEFAULT_WEIGHTS.liquidityWeight);
      this.weights.buyPressureWeight = getLearnedParameter('weight_buy_pressure', DEFAULT_WEIGHTS.buyPressureWeight);
      this.weights.consensusBonus = getLearnedParameter('weight_consensus', DEFAULT_WEIGHTS.consensusBonus);

      // Clamp to the honest band — never below the floor, never above the cap.
      const stored = getLearnedParameter('min_entry_score', 75);
      this.minEntryScore = Math.min(MIN_ENTRY_SCORE_CAP, Math.max(MIN_ENTRY_SCORE_FLOOR, stored));
      this.trailingStopPct = getLearnedParameter('trailing_stop_pct', 12.0);
      this.bepTriggerPct = getLearnedParameter('bep_trigger_pct', 20.0);

      const countRow = db.prepare("SELECT COUNT(*) as count FROM trade_history WHERE action = 'SELL'").get() as { count: number } | undefined;
      this.sampleTradeCount = countRow ? countRow.count : 0;

      console.log(`[SelfLearning] 🧠 Adaptive Learning Engine loaded (${this.sampleTradeCount} historical samples).`);
      console.log(`[SelfLearning] 📊 Hurdle=${this.minEntryScore.toFixed(0)} (adapts only at >=${MIN_TRADES_FOR_HURDLE_ADAPT} trades) | Weights FROZEN until ${MIN_TRADES_FOR_WEIGHT_ADAPT} trades`);
    } catch (err: any) {
      console.warn('[SelfLearning] Error loading parameters from DB, using priors:', err.message);
    }
  }

  public getScoringWeights(): ScoringWeights {
    return { ...this.weights };
  }

  public getMinEntryScore(): number {
    return Math.round(this.minEntryScore);
  }

  /**
   * Honest TP/SL targets. The production exit is the ratchet engine in
   * tradeManager (tiers +22/+45/+80/+150, hard SL -9.5%). This function only
   * stamps informational targets on the position record — it does NOT adapt
   * the stop-loss, because a stop that moves with 5 winning trades is not
   * risk management, it is overfitting.
   */
  public getDynamicTpSl(_realizedVol: number = 0): DynamicTpSlTargets {
    const targetSlPct = HARD_SL_PCT;
    const targetTpPct = 45.0;
    return {
      targetTpPct,
      targetSlPct,
      trailingStopPct: Math.round(this.trailingStopPct * 10) / 10,
      bepTriggerPct: 20.0,
      rrRatio: Math.round((targetTpPct / targetSlPct) * 10) / 10
    };
  }

  /**
   * Feedback loop, called on every closed trade.
   * - Always records setup-type attribution (data first).
   * - Hurdle adapts only with >= 30 samples, max +/-2 pts per adaptation.
   * - Component weights stay frozen until 200 samples (offline fit territory).
   */
  public onTradeClosed(outcome: TradeOutcomeFeedback): void {
    try {
      this.sampleTradeCount += 1;
      // m-3 (2026-09-29): NET unification. A trade that is gross-positive but
      // net-negative (fees ate it) is a LOSS — the old `|| outcome.pnlPct > 0`
      // counted it as a win and flattered the attribution win-rate.
      // One definition of win/loss = NET, everywhere.
      const isWin = outcome.netPnlSol > 0;
      const setupKey = this.normalizeSetupKey(outcome.setupType, outcome.strategySource, outcome.reason);

      const existingAttributions = getStrategyAttributionRecords();
      let record = existingAttributions.find(a => a.strategy_id === setupKey);
      if (!record) {
        record = {
          strategy_id: setupKey,
          total_trades: 0,
          wins: 0,
          losses: 0,
          win_rate: 50.0,
          gross_profit_sol: 0,
          gross_loss_sol: 0,
          profit_factor: 1.0,
          current_weight: 20.0,
          last_adapted_at: new Date().toISOString()
        };
      }

      record.total_trades += 1;
      if (isWin) {
        record.wins += 1;
        record.gross_profit_sol += Math.max(0, outcome.netPnlSol);
      } else {
        record.losses += 1;
        record.gross_loss_sol += Math.abs(outcome.netPnlSol);
      }
      record.win_rate = Number(((record.wins / record.total_trades) * 100).toFixed(1));
      record.profit_factor = record.gross_loss_sol > 0
        ? Number((record.gross_profit_sol / record.gross_loss_sol).toFixed(2))
        : (record.gross_profit_sol > 0 ? 5.0 : 1.0);
      record.last_adapted_at = new Date().toISOString();

      // Weight field repurposed as a damped conviction score — informational only
      // until the sample is large enough for a real fit. Bounded random walk.
      if (record.total_trades >= 10) {
        const pf = record.profit_factor;
        const drift = pf >= 1.5 ? 0.5 : pf < 0.9 ? -0.5 : 0;
        record.current_weight = Math.max(8.0, Math.min(32.0, record.current_weight + drift));
      }
      upsertStrategyAttributionRecord(record);

      // Gated hurdle adaptation — the only online parameter move we allow.
      this.adaptEntryHurdleGated();

      this.persistParameters();

      console.log(`[SelfLearning] 🧠 ${outcome.tokenSymbol}: ${outcome.netPnlSol >= 0 ? '+' : ''}${outcome.netPnlSol.toFixed(4)} SOL (${outcome.pnlPct.toFixed(1)}%) | Setup: ${setupKey} [n=${record.total_trades} PF=${record.profit_factor} WR=${record.win_rate}%] | Hurdle=${this.minEntryScore.toFixed(0)}`);
    } catch (err: any) {
      console.error('[SelfLearning] Error during onTradeClosed:', err.message);
    }
  }

  /**
   * The ONLY online parameter adaptation. Moves the entry hurdle at most
   * +/-2 points per closed trade, only after 30 closed trades, hard-bounded
   * to [68, 80]. Small, slow, and honest — like a real risk committee.
   */
  private adaptEntryHurdleGated(): void {
    if (this.sampleTradeCount < MIN_TRADES_FOR_HURDLE_ADAPT) return;
    try {
      // M-6 (2026-09-29): NET unification. The old query read pnl_sol (gross
      // of buy fee) — a marginally gross-positive / net-negative trade counted
      // as a win, biasing the 15-trade win-rate optimistic and loosening the
      // entry hurdle exactly when it should tighten. One definition = NET.
      const recentRows = db.prepare(`
        SELECT net_pnl_sol FROM trade_history
        WHERE action = 'SELL'
        ORDER BY id DESC LIMIT 15
      `).all() as Array<{ net_pnl_sol: number }>;
      if (recentRows.length < 10) return;

      const wins = recentRows.filter(r => (r.net_pnl_sol ?? 0) > 0).length;
      const winRate = (wins / recentRows.length) * 100;

      let target = 75;
      if (winRate < 35) target = 78;       // cold streak: demand A+ only
      else if (winRate < 45) target = 76;  // soft: slightly defensive
      else if (winRate >= 60) target = 72; // hot: widen the funnel a touch
      else target = 75;                    // normal regime

      const bounded = Math.min(MIN_ENTRY_SCORE_CAP, Math.max(MIN_ENTRY_SCORE_FLOOR, target));
      const move = Math.max(-MAX_HURDLE_MOVE_PER_ADAPT, Math.min(MAX_HURDLE_MOVE_PER_ADAPT, bounded - this.minEntryScore));
      this.minEntryScore = Math.round((this.minEntryScore + move) * 10) / 10;
    } catch {}
  }

  private persistParameters(): void {
    // Weights are frozen — persist priors so a future offline fit has a clean slate.
    setLearnedParameter('weight_momentum', this.weights.momentumWeight, 5, 35, this.sampleTradeCount, 1.0, 'Frozen at prior until 200 attributed trades');
    setLearnedParameter('weight_volume', this.weights.volumeWeight, 5, 35, this.sampleTradeCount, 1.0, 'Frozen at prior until 200 attributed trades');
    setLearnedParameter('weight_flow', this.weights.flowWeight, 5, 35, this.sampleTradeCount, 1.0, 'Frozen at prior until 200 attributed trades');
    setLearnedParameter('weight_liquidity', this.weights.liquidityWeight, 5, 30, this.sampleTradeCount, 1.0, 'Frozen at prior until 200 attributed trades');
    setLearnedParameter('weight_buy_pressure', this.weights.buyPressureWeight, 5, 25, this.sampleTradeCount, 1.0, 'Frozen at prior until 200 attributed trades');
    setLearnedParameter('weight_consensus', this.weights.consensusBonus, 5, 15, this.sampleTradeCount, 1.0, 'Frozen at prior until 200 attributed trades');
    setLearnedParameter('min_entry_score', this.minEntryScore, MIN_ENTRY_SCORE_FLOOR, MIN_ENTRY_SCORE_CAP, this.sampleTradeCount, 0.9, 'Gated adaptive entry hurdle (+/-2 max per trade, >=30 samples)');
    setLearnedParameter('trailing_stop_pct', this.trailingStopPct, 10.0, 20.0, this.sampleTradeCount, 1.0, 'Adaptive trailing width lives in tradeManager ratchet');
    setLearnedParameter('bep_trigger_pct', this.bepTriggerPct, 8.0, 25.0, this.sampleTradeCount, 1.0, 'BEP trigger informational');
  }

  /**
   * Attribution key = the SETUP TYPE that actually fired, not a guessed
   * strategy name. This is what lets us answer "which setups make money?"
   */
  private normalizeSetupKey(setupType?: string, source?: string, reason?: string): string {
    const s = (setupType || '').toUpperCase();
    if (s.includes('PARABOLIC')) return 'PARABOLIC_BREAKOUT';
    if (s.includes('PULLBACK')) return 'PULLBACK_ABSORPTION';
    if (s.includes('WHALE')) return 'WHALE_COPY';
    if (s.includes('MOMENTUM')) return 'MOMENTUM_RUNNER';
    if (s.includes('QUANT')) return 'QUANT_MOMENTUM';
    if (s.includes('MANUAL') || s.includes('SNIPER')) return 'MANUAL_SNIPER';
    const src = (source || '').toUpperCase();
    if (src.includes('COPY')) return 'WHALE_COPY';
    if (src.includes('ALGO')) return 'ALGO_AUTONOMOUS';
    const r = (reason || '').toUpperCase();
    if (r.includes('WHALE')) return 'WHALE_COPY';
    return 'ALGO_AUTONOMOUS';
  }

  public getDiagnosticsReport(): string {
    const attributions = getStrategyAttributionRecords();
    const attrLines = attributions.map(a =>
      `• *${a.strategy_id}*: WR ${a.win_rate}% | PF ${a.profit_factor} (${a.total_trades} trade)`
    ).join('\n');

    const gate = this.sampleTradeCount >= MIN_TRADES_FOR_HURDLE_ADAPT
      ? 'AKTIF'
      : `TERKUNCI (butuh ${MIN_TRADES_FOR_HURDLE_ADAPT - this.sampleTradeCount} trade lagi)`;

    return `🧠 *DIAGNOSTIK SELF-LEARNING BOT*\n\n` +
      `📊 *Sample Trade:* ${this.sampleTradeCount}\n` +
      `🎯 *Entry Hurdle:* *${this.minEntryScore.toFixed(0)}/100* — adaptasi ${gate}\n` +
      `🛡️ *Hard Stop-Loss:* *-${HARD_SL_PCT}%* (konstan, tidak diadaptasi)\n` +
      `⚖️ *Bobot Skorer:* FROZEN di prior hingga ${MIN_TRADES_FOR_WEIGHT_ADAPT} trade\n\n` +
      (attrLines ? `🏆 *Atribusi per Setup:*\n${attrLines}` : '_Belum ada trade tertutup untuk atribusi._');
  }
}

export const adaptiveLearningEngine = new AdaptiveLearningEngine();
