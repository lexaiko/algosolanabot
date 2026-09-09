import { CONFIG } from '../../config';
import { ExitEvaluationContext, ExitEvaluationResult } from '../types';

export class WhaleDumpRule {
  id = 'EXIT_WHALE_DUMP';
  name = 'Whale Exit Synchronization Rule';

  evaluate(context: ExitEvaluationContext): ExitEvaluationResult | null {
    if (!CONFIG.COPY_SELL_ENABLED) return null;

    const { position, whaleExited, whaleSellAmountPct } = context;

    if (whaleExited) {
      const sellAmount = whaleSellAmountPct ? ` sebesar ${whaleSellAmountPct}%` : '';
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        ruleTriggered: this.id,
        currentPnlPct: position.pnl_pct,
        reason: `🐋 Whale Source (${position.whale_source || 'Unknown'}) telah menjual posisinya${sellAmount}. Auto-copy sell aktif untuk keluar bersama paus.`
      };
    }

    return null;
  }
}
