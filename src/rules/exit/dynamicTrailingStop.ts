import { CONFIG } from '../../config';
import { ExitEvaluationContext, ExitEvaluationResult } from '../types';

export class DynamicTrailingStopRule {
  id = 'EXIT_DYNAMIC_TRAILING_STOP';
  name = 'Multi-Tier TP & Dynamic Trailing Stop Rule';

  evaluate(context: ExitEvaluationContext): ExitEvaluationResult | null {
    const { position } = context;
    const pnlPct = position.pnl_pct;
    const peakPrice = position.peak_price_usd || position.entry_price_usd;
    const currentPrice = position.current_price_usd;

    const targetTp = position.target_tp_pct || CONFIG.TAKE_PROFIT_PCT || 42.0;
    const targetSl = position.target_sl_pct || CONFIG.STOP_LOSS_PCT || 14.0;
    const trailingStopPct = CONFIG.TRAILING_STOP_PCT || 18.0;

    // 1. Stage 1: Asymmetric Take Profit (Sell 50% to secure capital & free-roll moonbag)
    if (position.is_half_closed === 0 && pnlPct >= targetTp) {
      return {
        shouldExit: true,
        action: 'HALF_SELL',
        ruleTriggered: 'TP_STAGE_1_HALF',
        currentPnlPct: pnlPct,
        targetPriceUsd: currentPrice,
        reason: `Target TP Stage 1 Tercapai (+${pnlPct.toFixed(1)}% >= +${targetTp}%). Mengamankan 50% modal & profit, membiarkan 50% sisa menjadi Risk-Free Moonbag!`,
        details: { targetTp, pnlPct, isHalfClosed: 0 }
      };
    }

    // 2. Hard Stop Loss (Max Drawdown Ceiling)
    if (pnlPct <= -targetSl) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        ruleTriggered: 'HARD_STOP_LOSS',
        currentPnlPct: pnlPct,
        targetPriceUsd: currentPrice,
        reason: `Hard Stop Loss Terpicu (${pnlPct.toFixed(1)}% <= -${targetSl}%). Memotong kerugian secara dingin untuk menjaga modal inti.`,
        details: { targetSl, pnlPct }
      };
    }

    // 3. Stage 2 Trailing Stop for Moonbag (Active after 50% TP was executed)
    if (position.is_half_closed === 1 && peakPrice > position.entry_price_usd) {
      const dropFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (dropFromPeakPct >= trailingStopPct) {
        return {
          shouldExit: true,
          action: 'FULL_SELL',
          ruleTriggered: 'MOONBAG_TRAILING_STOP',
          currentPnlPct: pnlPct,
          targetPriceUsd: currentPrice,
          reason: `Trailing Stop Moonbag Terpicu: Harga terkoreksi -${dropFromPeakPct.toFixed(1)}% dari puncak $${peakPrice.toFixed(6)}. Mengunci sisa profit pada net +${pnlPct.toFixed(1)}%!`,
          details: { dropFromPeakPct, trailingStopPct, peakPrice, currentPrice }
        };
      }
    }

    // 4. Breakeven Stop Floor: If position was up > +20% but didn't hit TP and is now retracing toward entry
    if (peakPrice >= position.entry_price_usd * 1.20 && pnlPct <= 2.0 && position.is_half_closed === 0) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        ruleTriggered: 'BREAKEVEN_GUARD',
        currentPnlPct: pnlPct,
        targetPriceUsd: currentPrice,
        reason: `Breakeven Floor Guard: Posisi sempat melonjak tinggi tetapi momentum berbalik. Menutup posisi pada +${pnlPct.toFixed(1)}% untuk mencegah trade pemenang menjadi kekalahan.`,
        details: { peakPrice, entryPrice: position.entry_price_usd, pnlPct }
      };
    }

    return null;
  }
}
