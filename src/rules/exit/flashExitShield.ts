import { CONFIG } from '../../config';
import { ExitEvaluationContext, ExitEvaluationResult } from '../types';

export class FlashExitShieldRule {
  id = 'EXIT_FLASH_SHIELD';
  name = 'Emergency Liquidity Drain Flash Exit Shield';

  evaluate(context: ExitEvaluationContext): ExitEvaluationResult | null {
    if (!CONFIG.FLASH_EXIT_ENABLED) return null;

    const { position, currentMarketData, currentLiquidityUsd, entryLiquidityUsd } = context;
    const liveLiquidity = currentLiquidityUsd ?? currentMarketData?.liquidityUsd ?? 0;
    const flashDropPct = CONFIG.FLASH_EXIT_DROP_PCT || 30.0;

    // 1. Relative Liquidity Drain Detection (e.g. Pool drained > 30% from entry)
    if (entryLiquidityUsd && entryLiquidityUsd > 0 && liveLiquidity > 0) {
      const dropPct = ((entryLiquidityUsd - liveLiquidity) / entryLiquidityUsd) * 100;
      if (dropPct >= flashDropPct) {
        return {
          shouldExit: true,
          action: 'FULL_SELL',
          ruleTriggered: this.id,
          currentPnlPct: position.pnl_pct,
          reason: `🚨 FLASH EXIT SHIELD: Likuiditas pool terdeteksi anjlok -${dropPct.toFixed(1)}% dari entry ($${entryLiquidityUsd.toFixed(0)} -> $${liveLiquidity.toFixed(0)}). Menghindari rugpull penarikan likuiditas!`,
          details: { entryLiquidityUsd, liveLiquidity, dropPct, flashDropPct }
        };
      }
    }

    // 2. Absolute Critical Floor Breach (< 50% of configured minimum floor)
    const absoluteCriticalFloor = (CONFIG.MIN_LIQUIDITY_USD || 6000) * 0.5;
    if (liveLiquidity > 0 && liveLiquidity < absoluteCriticalFloor) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        ruleTriggered: this.id,
        currentPnlPct: position.pnl_pct,
        reason: `🚨 FLASH EXIT SHIELD: Likuiditas pool ambles kritis ke $${liveLiquidity.toFixed(0)} (< $${absoluteCriticalFloor.toFixed(0)}). Emergency exit untuk mengamankan sisa modal!`,
        details: { liveLiquidity, absoluteCriticalFloor }
      };
    }

    return null;
  }
}
