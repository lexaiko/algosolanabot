import { CONFIG } from '../../config';
import { ExitEvaluationContext, ExitEvaluationResult } from '../types';

export class TimeDecayExitRule {
  id = 'EXIT_TIME_DECAY';
  name = 'Time-Decay Stagnant Position Reaper';

  evaluate(context: ExitEvaluationContext): ExitEvaluationResult | null {
    const { position } = context;
    if (!position.opened_at) return null;

    const openedAtMs = new Date(position.opened_at).getTime();
    if (isNaN(openedAtMs)) return null;

    const ageHours = (Date.now() - openedAtMs) / (1000 * 60 * 60);
    const maxHoldHours = CONFIG.MAX_HOLD_TIME_HOURS || 24;

    // 1. Hard Maximum Hold Time Ceiling (Zombie Reaper)
    if (ageHours >= maxHoldHours) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        ruleTriggered: this.id,
        currentPnlPct: position.pnl_pct,
        reason: `Maksimal durasi hold (${maxHoldHours} jam) tercapai (Durasi: ${ageHours.toFixed(1)}j, PnL: ${position.pnl_pct.toFixed(1)}%). Melikuidasi untuk membebaskan modal.`
      };
    }

    // 2. Pro Momentum Decay: Jika sudah hold > 2 jam dan PnL jalan di tempat (-8% s/d +5%), exit awal
    if (ageHours >= 2.0 && position.pnl_pct >= -8.0 && position.pnl_pct <= 5.0 && position.is_half_closed === 0) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        ruleTriggered: this.id,
        currentPnlPct: position.pnl_pct,
        reason: `Momentum Decay: Posisi stagnan selama ${ageHours.toFixed(1)} jam (PnL: ${position.pnl_pct.toFixed(1)}%). Re-allocating capital ke token berkecepatan tinggi.`
      };
    }

    return null;
  }
}
