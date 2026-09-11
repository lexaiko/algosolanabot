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
  whaleWeight: number;
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
  holdingDurationSeconds?: number;
}

export class AdaptiveLearningEngine {
  // In-memory active parameters synced with SQLite
  private weights: ScoringWeights = {
    momentumWeight: 20,
    volumeWeight: 20,
    flowWeight: 20,
    liquidityWeight: 20,
    whaleWeight: 15,
    consensusBonus: 10
  };

  private minEntryScore: number = 75; // Hedge Fund standard: only take A+ setups (>= 75 score)
  private baseSlPct: number = 8.5; // Strict capital preservation ceiling
  private baseTpMultiplier: number = 4.0; // High asymmetry payoff target
  private trailingStopPct: number = 12.0;
  private bepTriggerPct: number = 20.0;
  private sampleTradeCount: number = 0;

  constructor() {
    this.loadFromDatabase();
  }

  /**
   * Initializes and loads all learned parameters and Bayesian priors from SQLite.
   */
  public loadFromDatabase(): void {
    try {
      this.weights.momentumWeight = getLearnedParameter('weight_momentum', 20);
      this.weights.volumeWeight = getLearnedParameter('weight_volume', 20);
      this.weights.flowWeight = getLearnedParameter('weight_flow', 20);
      this.weights.liquidityWeight = getLearnedParameter('weight_liquidity', 20);
      this.weights.whaleWeight = getLearnedParameter('weight_whale', 15);
      this.weights.consensusBonus = getLearnedParameter('weight_consensus', 10);

      this.minEntryScore = Math.max(75, getLearnedParameter('min_entry_score', 75));
      this.baseSlPct = Math.min(8.5, getLearnedParameter('base_sl_pct', 8.5));
      this.baseTpMultiplier = Math.max(4.0, getLearnedParameter('base_tp_multiplier', 4.0));
      this.trailingStopPct = getLearnedParameter('trailing_stop_pct', 12.0);
      this.bepTriggerPct = getLearnedParameter('bep_trigger_pct', 20.0);

      // Count historical closed trades for sample count
      const countRow = db.prepare("SELECT COUNT(*) as count FROM trade_history WHERE action = 'SELL'").get() as { count: number } | undefined;
      this.sampleTradeCount = countRow ? countRow.count : 0;

      console.log(`[SelfLearning] 🧠 Adaptive Learning Engine loaded (${this.sampleTradeCount} historical samples).`);
      console.log(`[SelfLearning] 📊 Current Weights: Mom=${this.weights.momentumWeight.toFixed(1)}, Vol=${this.weights.volumeWeight.toFixed(1)}, Flow=${this.weights.flowWeight.toFixed(1)}, Liq=${this.weights.liquidityWeight.toFixed(1)}, Whale=${this.weights.whaleWeight.toFixed(1)} | MinScore=${this.minEntryScore.toFixed(0)}`);
    } catch (err: any) {
      console.warn('[SelfLearning] Error loading parameters from DB, using Bayesian defaults:', err.message);
    }
  }

  /**
   * Returns live dynamic scoring weights
   */
  public getScoringWeights(): ScoringWeights {
    return { ...this.weights };
  }

  /**
   * Returns live dynamic minimum composite entry score
   */
  public getMinEntryScore(): number {
    return Math.round(this.minEntryScore);
  }

  /**
   * Returns live dynamic Take-Profit & Stop-Loss targets adapted to current volatility
   */
  public getDynamicTpSl(realizedVol: number = 0, atrPct: number = 0): DynamicTpSlTargets {
    // Hedge Fund Quant Asymmetry: Cap losses strictly, allow targets to expand dynamically
    const vol = Math.max(realizedVol, atrPct);
    const volSlAdjustment = Math.min(1.5, vol * 0.05);
    const targetSlPct = Math.min(9.5, Math.max(7.5, this.baseSlPct + volSlAdjustment));

    // Dynamic TP multiplier expands on high volatility to capture massive meme runners
    const dynamicTpMultiplier = this.baseTpMultiplier + Math.min(2.5, vol / 12.0);
    const targetTpPct = Math.min(150.0, Math.max(45.0, targetSlPct * dynamicTpMultiplier));

    return {
      targetTpPct: Math.round(targetTpPct * 10) / 10,
      targetSlPct: Math.round(targetSlPct * 10) / 10,
      trailingStopPct: Math.round(this.trailingStopPct * 10) / 10,
      bepTriggerPct: 20.0, // Only transition to protective floor after a solid +20% pump
      rrRatio: Math.round((targetTpPct / targetSlPct) * 10) / 10
    };
  }

  /**
   * Primary Feedback Loop: Called automatically whenever a trade closes.
   * Recalculates win rate, adjusts strategy attribution, adapts weights, and tunes TP/SL.
   */
  public onTradeClosed(outcome: TradeOutcomeFeedback): void {
    try {
      this.sampleTradeCount += 1;
      const isWin = outcome.netPnlSol > 0 || outcome.pnlPct > 0;
      const strategyKey = this.normalizeStrategyKey(outcome.strategySource, outcome.reason);

      // 1. Update Strategy Performance Attribution
      const existingAttributions = getStrategyAttributionRecords();
      let record = existingAttributions.find(a => a.strategy_id === strategyKey);
      if (!record) {
        record = {
          strategy_id: strategyKey,
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

      // Multi-Armed Bandit / Online Gradient Weight Adaptation
      const learningRate = 0.08;
      let weightDelta = 0;
      if (record.profit_factor >= 1.5 && record.win_rate >= 50) {
        weightDelta = learningRate * (record.profit_factor - 1.0) * 5;
      } else if (record.profit_factor < 0.9 || record.win_rate < 40) {
        weightDelta = -learningRate * Math.abs(1.0 - record.profit_factor) * 5;
      }
      record.current_weight = Math.max(8.0, Math.min(32.0, record.current_weight + weightDelta));
      upsertStrategyAttributionRecord(record);

      // 2. Adjust Component Weights in OpportunityScorer
      this.adaptScoringWeights();

      // 3. Compute Rolling Win Rate of last 15 trades to adapt Hurdle Rate & TP/SL
      this.adaptSystemHurdleAndPayoff();

      // 4. Persist updated parameters to SQLite
      this.persistParameters();

      console.log(`[SelfLearning] 🧠 Trade outcome learned for ${outcome.tokenSymbol}: Net ${outcome.netPnlSol >= 0 ? '+' : ''}${outcome.netPnlSol.toFixed(4)} SOL (${outcome.pnlPct.toFixed(1)}%). Strategy: ${strategyKey} [PF: ${record.profit_factor}, WR: ${record.win_rate}%]`);
    } catch (err: any) {
      console.error('[SelfLearning] Error during onTradeClosed adaptation:', err.message);
    }
  }

  /**
   * Adapts scoring weights based on performance attribution
   */
  private adaptScoringWeights(): void {
    const attributions = getStrategyAttributionRecords();
    for (const attr of attributions) {
      if (attr.strategy_id === 'MOMENTUM') {
        this.weights.momentumWeight = attr.current_weight;
      } else if (attr.strategy_id === 'VOLUME') {
        this.weights.volumeWeight = attr.current_weight;
      } else if (attr.strategy_id === 'FLOW_IMBALANCE') {
        this.weights.flowWeight = attr.current_weight;
      } else if (attr.strategy_id === 'WHALE') {
        this.weights.whaleWeight = Math.min(22.0, attr.current_weight * 0.85);
      }
    }
  }

  /**
   * Adapts Entry Hurdle Rate and TP/SL based on rolling 15-trade win rate and payoff
   */
  private adaptSystemHurdleAndPayoff(): void {
    try {
      const recentRows = db.prepare(`
        SELECT pnl_sol, pnl_pct 
        FROM trade_history 
        WHERE action = 'SELL' 
        ORDER BY id DESC 
        LIMIT 15
      `).all() as Array<{ pnl_sol: number; pnl_pct: number }>;

      if (recentRows.length >= 3) {
        const wins = recentRows.filter(r => r.pnl_sol > 0);
        const winRate = (wins.length / recentRows.length) * 100;

        const avgWinPct = wins.length > 0 
          ? wins.reduce((s, w) => s + w.pnl_pct, 0) / wins.length 
          : 35.0;
        const losses = recentRows.filter(r => r.pnl_sol <= 0);
        const avgLossPct = losses.length > 0 
          ? Math.abs(losses.reduce((s, l) => s + l.pnl_pct, 0) / losses.length) 
          : 12.0;

        // Adaptive Hurdle: If win rate drops, raise score hurdle to filter low-quality setups
        if (winRate < 40) {
          this.minEntryScore = 76.0; // Highly defensive
          this.baseSlPct = 10.0;     // Tighten stop loss
        } else if (winRate < 50) {
          this.minEntryScore = 70.0; // Cautious
          this.baseSlPct = 11.5;
        } else if (winRate >= 65) {
          this.minEntryScore = 63.0; // Aggressive capture
          this.baseSlPct = 12.5;
        } else {
          this.minEntryScore = 66.0; // Standard
          this.baseSlPct = 12.0;
        }

        // Adaptive TP Multiplier: Expand if average win is large (fat-tail runners exist)
        if (avgWinPct > 45.0) {
          this.baseTpMultiplier = Math.min(4.8, Math.max(3.0, (avgWinPct / Math.max(1, avgLossPct))));
        } else {
          this.baseTpMultiplier = 3.2;
        }
      }
    } catch {}
  }

  /**
   * Persists all parameters into SQLite
   */
  private persistParameters(): void {
    setLearnedParameter('weight_momentum', this.weights.momentumWeight, 5, 35, this.sampleTradeCount, 0.8, 'Adaptive momentum weight');
    setLearnedParameter('weight_volume', this.weights.volumeWeight, 5, 35, this.sampleTradeCount, 0.8, 'Adaptive volume weight');
    setLearnedParameter('weight_flow', this.weights.flowWeight, 5, 35, this.sampleTradeCount, 0.8, 'Adaptive flow imbalance weight');
    setLearnedParameter('weight_liquidity', this.weights.liquidityWeight, 5, 30, this.sampleTradeCount, 0.8, 'Adaptive liquidity weight');
    setLearnedParameter('weight_whale', this.weights.whaleWeight, 5, 25, this.sampleTradeCount, 0.8, 'Adaptive whale weight');
    setLearnedParameter('weight_consensus', this.weights.consensusBonus, 5, 15, this.sampleTradeCount, 0.8, 'Consensus bonus');

    setLearnedParameter('min_entry_score', this.minEntryScore, 60, 82, this.sampleTradeCount, 0.8, 'Adaptive minimum entry score hurdle');
    setLearnedParameter('base_sl_pct', this.baseSlPct, 8.0, 16.0, this.sampleTradeCount, 0.8, 'Adaptive base stop loss pct');
    setLearnedParameter('base_tp_multiplier', this.baseTpMultiplier, 2.5, 5.5, this.sampleTradeCount, 0.8, 'Adaptive base TP multiplier');
    setLearnedParameter('trailing_stop_pct', this.trailingStopPct, 12.0, 24.0, this.sampleTradeCount, 0.8, 'Adaptive trailing stop pct');
    setLearnedParameter('bep_trigger_pct', this.bepTriggerPct, 8.0, 18.0, this.sampleTradeCount, 0.8, 'Adaptive break-even trigger pct');
  }

  private normalizeStrategyKey(source?: string, reason?: string): string {
    const s = `${source || ''} ${reason || ''}`.toUpperCase();
    if (s.includes('MOMENTUM')) return 'MOMENTUM';
    if (s.includes('BREAKOUT')) return 'BREAKOUT';
    if (s.includes('FLOW') || s.includes('IMBALANCE')) return 'FLOW_IMBALANCE';
    if (s.includes('WHALE') || s.includes('PAUS')) return 'WHALE';
    return 'ALGO_AUTONOMOUS';
  }

  /**
   * Diagnostic report for Telegram or console audit
   */
  public getDiagnosticsReport(): string {
    const attributions = getStrategyAttributionRecords();
    const attrLines = attributions.map(a => 
      `• *${a.strategy_id}*: Bobot ${a.current_weight.toFixed(1)} | WR: ${a.win_rate}% | PF: ${a.profit_factor} (${a.total_trades} trade)`
    ).join('\n');

    return `🧠 *DIAGNOSTIK SELF-LEARNING BOT*\n\n` +
      `📊 *Sample Trade Terserap:* ${this.sampleTradeCount} transaksi\n` +
      `🎯 *Ambang Batas Skor Masuk:* *${this.minEntryScore.toFixed(0)}/100* (Dinamis)\n` +
      `🛡️ *Base Stop-Loss:* *-${this.baseSlPct.toFixed(1)}%*\n` +
      `📈 *Base TP Multiplier:* *${this.baseTpMultiplier.toFixed(2)}x* (R:R Asimetris)\n` +
      `🌕 *Trailing Stop Moonbag:* *${this.trailingStopPct.toFixed(1)}%*\n\n` +
      `⚖️ *Bobot Komponen Strategi Saat Ini:*\n` +
      `• Momentum: *${this.weights.momentumWeight.toFixed(1)}*\n` +
      `• Volume Acceleration: *${this.weights.volumeWeight.toFixed(1)}*\n` +
      `• Order Flow Imbalance: *${this.weights.flowWeight.toFixed(1)}*\n` +
      `• Likuiditas Pool: *${this.weights.liquidityWeight.toFixed(1)}*\n` +
      `• Smart Money / Paus: *${this.weights.whaleWeight.toFixed(1)}*\n\n` +
      (attrLines ? `🏆 *Attribusi Performa Strategi:*\n${attrLines}` : '_Belum ada trade tertutup untuk atribusi._');
  }
}

export const adaptiveLearningEngine = new AdaptiveLearningEngine();
