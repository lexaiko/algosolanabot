import { CONFIG } from '../config';

/**
 * Single source of truth for execution-cost math (exit-risk fix, 2026-09-29).
 * Previously estimateRoundTripFeePct was duplicated in tradeManager.ts and
 * positionManager.ts with a hard 2 x 1.25% DEX fee, and the ratchet floor
 * formula lived in two places with a cliff at every tier boundary.
 */

/**
 * Estimates round-trip execution cost as % of position notional.
 *
 * M-7/F-10 (2026-09-29): VENUE-AWARE. Pump.fun DEX fee is 1.25%/side
 * (0.95% protocol + 0.30% creator), Raydium is 0.25%/side — the same venue
 * split dexSimulator.ts already uses for simulated fills. The old flat
 * 2 x 1.25% overstated every Raydium ratchet floor by ~2pp, causing
 * systematically premature (whipsaw) exits on Raydium positions.
 *
 * @param entrySol  position notional in SOL (network fee expressed against it)
 * @param isPump    true for pump.fun bonding-curve tokens (mint endsWith 'pump')
 */
export function estimateRoundTripFeePct(entrySol: number, isPump: boolean = true): number {
  const dexFeePct = 2 * (isPump ? 1.25 : 0.25); // buy-side + sell-side venue fee
  const networkFeeSol = (CONFIG.ESTIMATED_BUY_FEE_SOL || 0.00035) + (CONFIG.ESTIMATED_SELL_FEE_SOL || 0.00025);
  const networkFeePct = entrySol > 0 ? (networkFeeSol / entrySol) * 100 : 2.0;
  return dexFeePct + networkFeePct;
}

/**
 * M-3/F-09 (2026-09-29): CONTINUOUS ratchet floor — the old tiered ladder had a
 * cliff at every boundary (peak +44.9% -> floor +3.5%+fee, peak +45.0% ->
 * floor +32.75%+fee: 0.1pp of measurement noise decided ~29pp of outcome).
 *
 * floor(peak) = max(guarantee(peak), peak - trail(peak)) + feeBuffer, where
 * guarantee ramps linearly 3.5% -> 25% over [22,45) and the segment minimums
 * 25/50/100 apply over [45,80)/[80,150)/[150,inf). Continuous at 22/45/80/150
 * by construction (left/right limits: 3.5 / 25.0 / 66.0 / 132.5 pp pre-fee).
 *
 * Honest note: with the current adaptive trail (10 + 5% of peak, clamped
 * [10,20]pp), peak - trail dominates the guarantee everywhere >= 22%, so this
 * is effectively a pure adaptive trailing stop from +22% with the guarantees
 * kept as safety rails (they bind if the trail formula ever widens).
 * Consequence vs the old flat Tier-1: the floor now RISES with peak — more
 * profit locked, but more whipsaw in chop. That is the price of continuity.
 *
 * @returns floor in % (NET of fees), or null when no tier is armed (peak < 22%)
 */
export function computeRatchetFloorPct(
  peakGainPct: number,
  entrySol: number,
  isPump: boolean = true
): number | null {
  if (!(peakGainPct >= 22)) return null;
  const feeBufferPct = estimateRoundTripFeePct(entrySol, isPump);
  const trailPct = Math.min(20, Math.max(10, 10 + peakGainPct * 0.05));
  let guaranteePct: number;
  if (peakGainPct < 45) {
    guaranteePct = 3.5 + (peakGainPct - 22) * (21.5 / 23); // linear ramp 3.5 -> 25
  } else if (peakGainPct < 80) {
    guaranteePct = 25;
  } else if (peakGainPct < 150) {
    guaranteePct = 50;
  } else {
    guaranteePct = 100;
  }
  return Math.max(guaranteePct, peakGainPct - trailPct) + feeBufferPct;
}
