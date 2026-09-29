import { PositionRecord } from '../core/types';
import { IStorageRepository } from '../storage/interfaces';
import { CONFIG } from '../config';
// [EXITFIX] 2026-09-29: single source of truth — the mirror must price fees and
// the ratchet floor EXACTLY like production (tradeManager via feeModel).
import { computeRatchetFloorPct } from './feeModel';

export interface ExitSignal {
  shouldExit: boolean;
  action: 'HOLD' | 'HALF_SELL' | 'FULL_SELL';
  reason: string;
  ruleTriggered: string;
}

export class PositionManager {
  private storage?: IStorageRepository;

  constructor(storage?: IStorageRepository) {
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
   *
   * [EXITFIX] 2026-09-29 sync points (must stay identical to production):
   * - flash exit: CONFIG.FLASH_EXIT_DROP_PCT + $12k collapse floor + prev liq > $5k
   * - ratchet: computeRatchetFloorPct (continuous, no cliffs) via feeModel
   * - zombie reaper v2 lower bound -9.0% (aligned with hard SL -9.5%)
   * - max hold: CONFIG.MAX_HOLD_TIME_HOURS
   * - fee buffer: venue-aware estimateRoundTripFeePct via feeModel
   * Known approximation: production compares liquidity against the last-known
   * rolling value; the mirror compares against initialLiquidityUsd.
   */
  public evaluatePositionExit(params: {
    position: PositionRecord;
    currentPriceUsd: number;
    currentLiquidityUsd?: number;
    initialLiquidityUsd?: number;
    nowMs?: number;
    solPriceUsd?: number;
  }): ExitSignal {
    const { position, currentPriceUsd, currentLiquidityUsd, initialLiquidityUsd } = params;
    const nowMs = params.nowMs ?? Date.now();
    const isPump = String(position.tokenId || '').endsWith('pump');

    // Update peak price high watermark
    if (currentPriceUsd > position.peakPriceUsd) {
      position.peakPriceUsd = currentPriceUsd;
    }
    position.currentPriceUsd = currentPriceUsd;

    // Calculate current PnL
    const pnlPct = ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
    position.pnlPct = Number(pnlPct.toFixed(2));
    // m-6 (2026-09-29): the old literal $150 SOL price is gone — caller passes
    // the real price; without it pnlUsd is honestly 0, not a fiction.
    const solUsd = params.solPriceUsd && params.solPriceUsd > 0 ? params.solPriceUsd : 0;
    position.pnlUsd = (position.entrySol * solUsd) * (pnlPct / 100);

    const ageSec = (nowMs - new Date(position.openedAt).getTime()) / 1000;

    // 0. EMERGENCY FLASH LIQUIDITY EXIT (M-2: same rule as production —
    // CONFIG.FLASH_EXIT_DROP_PCT + collapse below $12k + prior liq > $5k)
    const flashDropThreshold = CONFIG.FLASH_EXIT_DROP_PCT > 0 ? CONFIG.FLASH_EXIT_DROP_PCT : 50.0;
    if (initialLiquidityUsd && initialLiquidityUsd > 5000 && currentLiquidityUsd && currentLiquidityUsd > 0) {
      const dropPct = ((initialLiquidityUsd - currentLiquidityUsd) / initialLiquidityUsd) * 100;
      if (dropPct >= flashDropThreshold && currentLiquidityUsd < 12000) {
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

    // 3. DYNAMIC RATCHET TRAILING STOP — 100% single exit (M-3 continuous floor,
    // M-7 venue-aware fee buffer; identical to production via feeModel)
    if (position.peakPriceUsd > position.entryPriceUsd) {
      const peakGainPct = ((position.peakPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
      const ratchetFloorPct = computeRatchetFloorPct(peakGainPct, position.entrySol, isPump);
      if (ratchetFloorPct !== null && pnlPct <= ratchetFloorPct) {
        const tier = peakGainPct >= 150 ? 'T4_MEGA' : peakGainPct >= 80 ? 'T3_SUPER' : peakGainPct >= 45 ? 'T2_SOLID' : 'T1_BEP';
        return {
          shouldExit: true,
          action: 'FULL_SELL',
          reason: `RATCHET_${tier}: peak +${peakGainPct.toFixed(1)}% -> floor +${ratchetFloorPct.toFixed(1)}% net`,
          ruleTriggered: `RATCHET_${tier}`
        };
      }
    }

    // 4. ZOMBIE TIME-STOP REAPER v2 (QUANT-03): 2.5h held, stagnant band scales with peak.
    // m-2: lower bound -9.0% (was -6.0%) — aligned with production, closes the
    // dead zone where a stagnant loser was reaped by nothing.
    const peakGainPctZombie = position.peakPriceUsd > position.entryPriceUsd
      ? ((position.peakPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const zombieCeilPct = Math.min(12, Math.max(4, peakGainPctZombie * 0.5));
    const hoursHeld = ageSec / 3600;
    if (hoursHeld >= 2.5 && pnlPct >= -9.0 && pnlPct <= zombieCeilPct) {
      return {
        shouldExit: true,
        action: 'FULL_SELL',
        reason: `ZOMBIE TIME-STOP v2: ${hoursHeld.toFixed(1)}h held, peak +${peakGainPctZombie.toFixed(1)}% decayed to ${pnlPct.toFixed(1)}%`,
        ruleTriggered: 'ZOMBIE_TIME_STOP_V2'
      };
    }

    // 5. MAX HOLD hard ceiling — M-2: single source of truth is
    // CONFIG.MAX_HOLD_TIME_HOURS (default 24h), same as production.
    if (hoursHeld >= CONFIG.MAX_HOLD_TIME_HOURS) {
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
