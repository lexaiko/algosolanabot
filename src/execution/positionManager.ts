import { PositionRecord } from '../core/types';
import { IStorageRepository } from '../storage/interfaces';
import { CONFIG } from '../config';

export interface ExitSignal {
  shouldExit: boolean;
  action: 'HOLD' | 'HALF_SELL' | 'FULL_SELL';
  reason: string;
  ruleTriggered: string;
}

/**
 * Estimates round-trip execution cost as % of position notional (QUANT-01).
 * Mirrors tradeManager.estimateRoundTripFeePct so the backtester prices
 * ratchet floors on NET pnl exactly like production.
 */
function estimateRoundTripFeePct(entrySol: number): number {
  const dexFeePct = 2 * 1.25; // buy-side + sell-side protocol/creator fee
  const networkFeeSol = (CONFIG.ESTIMATED_BUY_FEE_SOL || 0.00035) + (CONFIG.ESTIMATED_SELL_FEE_SOL || 0.00025);
  const networkFeePct = entrySol > 0 ? (networkFeeSol / entrySol) * 100 : 2.0;
  return dexFeePct + networkFeePct;
}

export class PositionManager {
  private storage: IStorageRepository;

  constructor(storage: IStorageRepository) {
    this.storage = storage;
  }

  /**
   * Tick evaluation for an open position.
   *
   * MIRRORS src/services/tradeManager.ts :: evaluatePosition() (production).
   * Previously this module ran the retired Half-TP / moonbag logic, which made
   * every backtest result incomparable with live behavior. It now implements the
   * same 100% single-exit dynamic ratchet, net-of-fees floors (QUANT-01),
   * adaptive trailing width (QUANT-02) and zombie reaper v2 (QUANT-03).
   */
  public evaluatePositionExit(params: {
    position: PositionRecord;
    currentPriceUsd: number;
    currentLiquidityUsd?: number;
    initialLiquidityUsd?: number;
    nowMs?: number;
  }): ExitSignal {
    const { position, currentPriceUsd, currentLiquidityUsd, initialLiquidityUsd } = params;
    const nowMs = params.nowMs ?? Date.now();

    // Update peak price high watermark
    if (currentPriceUsd > position.peakPriceUsd) {
      position.peakPriceUsd = currentPriceUsd;
    }
    position.currentPriceUsd = currentPriceUsd;

    // Calculate current PnL
    const pnlPct = ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
    position.pnlPct = Number(pnlPct.toFixed(2));
    position.pnlUsd = (position.entrySol * 150) * (pnlPct / 100); // ~$150 SOL approximation

    const ageSec = (nowMs - new Date(position.openedAt).getTime()) / 1000;

    // 0. EMERGENCY FLASH LIQUIDITY EXIT (Pool drain > 30%)
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

    // 1. VELOCITY DUMP RESCUE (matches production: fresh collapse <= 90s & <= -14%,
    //    or plunge: <= -10% with a single violent tick drop >= 12%)
    const prevPrice = (position as any).prevPriceUsd ?? currentPriceUsd;
    const tickDropPct = prevPrice > 0 ? ((prevPrice - currentPriceUsd) / prevPrice) * 100 : 0;
    (position as any).prevPriceUsd = currentPriceUsd;
    const isFreshCollapse = ageSec <= 90 && pnlPct <= -14.0;
    const isPlungeDrop = pnlPct <= -10.0 && tickDropPct >= 12.0;
    if (isFreshCollapse || isPlungeDrop) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        reason: isFreshCollapse
          ? `VELOCITY DUMP RESCUE: fresh collapse ${pnlPct.toFixed(1)}% dalam ${ageSec.toFixed(0)}s`
          : `VELOCITY DUMP RESCUE: plunge drop ${pnlPct.toFixed(1)}% (tick -${tickDropPct.toFixed(1)}%)`,
        ruleTriggered: 'VELOCITY_DUMP_RESCUE'
      };
    }

    // 2. HARD STOP LOSS
    const targetSl = position.targetSlPct || CONFIG.STOP_LOSS_PCT || 9.5;
    if (pnlPct <= -targetSl) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        reason: `HARD STOP LOSS (${pnlPct.toFixed(1)}% <= -${targetSl}%)`,
        ruleTriggered: 'HARD_STOP_LOSS'
      };
    }

    // 3. DYNAMIC RATCHET TRAILING STOP — 100% single exit (QUANT-01 net floors, QUANT-02 adaptive width)
    if (position.peakPriceUsd > position.entryPriceUsd) {
      const peakGainPct = ((position.peakPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
      const feeBufferPct = estimateRoundTripFeePct(position.entrySol);
      const adaptiveTrailPct = Math.min(20, Math.max(10, 10 + peakGainPct * 0.05));
      let ratchetFloorPct: number | null = null;
      let ruleTriggered = '';

      if (peakGainPct >= 150.0) {
        ratchetFloorPct = Math.max(100.0, peakGainPct - adaptiveTrailPct) + feeBufferPct;
        ruleTriggered = 'RATCHET_T4_MEGA';
      } else if (peakGainPct >= 80.0) {
        ratchetFloorPct = Math.max(50.0, peakGainPct - adaptiveTrailPct) + feeBufferPct;
        ruleTriggered = 'RATCHET_T3_SUPER';
      } else if (peakGainPct >= 45.0) {
        ratchetFloorPct = Math.max(25.0, peakGainPct - adaptiveTrailPct) + feeBufferPct;
        ruleTriggered = 'RATCHET_T2_SOLID';
      } else if (peakGainPct >= 22.0) {
        ratchetFloorPct = 3.5 + feeBufferPct;
        ruleTriggered = 'RATCHET_T1_BEP_LOCK';
      }

      if (ratchetFloorPct !== null && pnlPct <= ratchetFloorPct) {
        return {
          shouldExit: true,
          action: 'FULL_SELL',
          reason: `${ruleTriggered}: peak +${peakGainPct.toFixed(1)}% -> locked @ +${ratchetFloorPct.toFixed(1)}% net`,
          ruleTriggered
        };
      }
    }

    // 4. ZOMBIE TIME-STOP REAPER v2 (QUANT-03): 2.5h held, stagnant band scales with peak
    const peakGainPctZombie = position.peakPriceUsd > position.entryPriceUsd
      ? ((position.peakPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const zombieCeilPct = Math.min(12, Math.max(4, peakGainPctZombie * 0.5));
    const hoursHeld = ageSec / 3600;
    if (hoursHeld >= 2.5 && pnlPct >= -6.0 && pnlPct <= zombieCeilPct) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        reason: `ZOMBIE TIME-STOP v2: ${hoursHeld.toFixed(1)}h held, peak +${peakGainPctZombie.toFixed(1)}% decayed to ${pnlPct.toFixed(1)}%`,
        ruleTriggered: 'ZOMBIE_TIME_STOP_V2'
      };
    }

    // 5. MAX HOLD 12h hard ceiling
    if (hoursHeld >= 12.0) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        reason: `MAX HOLD TIMEOUT: ${hoursHeld.toFixed(1)}h held`,
        ruleTriggered: 'MAX_HOLD_TIMEOUT'
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
