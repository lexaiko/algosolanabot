import { PositionRecord } from '../core/types';
import { IStorageRepository } from '../storage/interfaces';
import { CONFIG } from '../config';

export interface ExitSignal {
  shouldExit: boolean;
  action: 'HOLD' | 'HALF_SELL' | 'FULL_SELL';
  reason: string;
  ruleTriggered: string;
}

export class PositionManager {
  private storage: IStorageRepository;

  constructor(storage: IStorageRepository) {
    this.storage = storage;
  }

  /**
   * Tick evaluation for an open position
   */
  public evaluatePositionExit(params: {
    position: PositionRecord;
    currentPriceUsd: number;
    currentLiquidityUsd?: number;
    initialLiquidityUsd?: number;
  }): ExitSignal {
    const { position, currentPriceUsd, currentLiquidityUsd, initialLiquidityUsd } = params;

    // Update peak price high watermark
    if (currentPriceUsd > position.peakPriceUsd) {
      position.peakPriceUsd = currentPriceUsd;
    }
    position.currentPriceUsd = currentPriceUsd;

    // Calculate current PnL
    const pnlPct = ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
    position.pnlPct = Number(pnlPct.toFixed(2));
    position.pnlUsd = (position.entrySol * 150) * (pnlPct / 100); // ~$150 SOL approximation

    // 1. EMERGENCY FLASH LIQUIDITY EXIT (Pool drain > 30%)
    if (initialLiquidityUsd && currentLiquidityUsd && initialLiquidityUsd > 0) {
      const dropPct = ((initialLiquidityUsd - currentLiquidityUsd) / initialLiquidityUsd) * 100;
      if (dropPct >= 30.0) {
        return {
          shouldExit: true,
          action: 'FULL_SELL',
          reason: `FLASH EXIT: Pool likuiditas anjlok -${dropPct.toFixed(1)}% dari entry`,
          ruleTriggered: 'FLASH_LIQUIDITY_DRAIN'
        };
      }
    }

    // 2. HARD STOP LOSS
    if (pnlPct <= -position.targetSlPct) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        reason: `HARD STOP LOSS (${pnlPct.toFixed(1)}% <= -${position.targetSlPct}%)`,
        ruleTriggered: 'HARD_STOP_LOSS'
      };
    }

    // 3. STAGE 1 TAKE PROFIT (Sell 50% to secure capital & free-roll moonbag)
    if (!position.isHalfClosed && pnlPct >= position.targetTpPct) {
      return {
        shouldExit: true,
        action: 'HALF_SELL',
        reason: `STAGE 1 TP (+${pnlPct.toFixed(1)}% >= +${position.targetTpPct}%): Mengamankan 50% modal`,
        ruleTriggered: 'TP_STAGE_1_HALF'
      };
    }

    // 4. MOONBAG TRAILING STOP (After 50% TP executed)
    if (position.isHalfClosed && position.peakPriceUsd > position.entryPriceUsd) {
      const trailingDrop = ((position.peakPriceUsd - currentPriceUsd) / position.peakPriceUsd) * 100;
      const maxTrailing = CONFIG.TRAILING_STOP_PCT || 18.0;
      if (trailingDrop >= maxTrailing) {
        return {
          shouldExit: true,
          action: 'FULL_SELL',
          reason: `MOONBAG TRAILING STOP: Koreksi -${trailingDrop.toFixed(1)}% dari puncak (Net PnL: +${pnlPct.toFixed(1)}%)`,
          ruleTriggered: 'MOONBAG_TRAILING_STOP'
        };
      }
    }

    // 5. TIME-DECAY STAGNANT REAPER (Hold > 2h with stagnant PnL -6% to +4%)
    const openedMs = new Date(position.openedAt).getTime();
    const ageHours = (Date.now() - openedMs) / (1000 * 60 * 60);
    if (ageHours >= 2.0 && pnlPct >= -6.0 && pnlPct <= 4.0 && !position.isHalfClosed) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        reason: `MOMENTUM DECAY: Posisi mandek selama ${ageHours.toFixed(1)} jam, merealokasi modal`,
        ruleTriggered: 'TIME_DECAY_REAPER'
      };
    }

    return {
      shouldExit: false,
      action: 'HOLD',
      reason: 'Posisi dalam batas normal (HOLD)',
      ruleTriggered: 'NORMAL_HOLD'
    };
  }
}
