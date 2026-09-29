/**
 * MOMENTUM_CONTINUATION tracker (2026-09-29).
 *
 * Problem: the TOP_TICK_FOMO_GUARD (entryEngine Invalidation 4) rejects every
 * 75+ token clinging to its 5m peak and parks it in "wait for a -2%..-6%
 * pullback". On real runners (e.g. INUINK +84%/6h after 4 skips on 2026-09-29)
 * the pullback never comes — the bot watches the whole move from the
 * sidelines. For a trading/scalping mandate that is a structural miss.
 *
 * This module implements the SECOND entry model next to PULLBACK_ABSORPTION:
 * instead of demanding a dip, it demands PROOF the rally is real — N
 * consecutive higher-high pushes, each with rising volume and buy-dominant
 * flow. A one-candle spike with no follow-through never confirms.
 *
 * Lifecycle per mint:
 *   observe() -> { confirmations: 0..3, confirmed: false }   (tracking)
 *   observe() -> { confirmations: 3, confirmed: true }        (fire ONCE)
 *   markContinuationConsumed(mint)                            (after a fill)
 *   drawdown > 4% from tracked peak -> record deleted (thesis dead)
 *   45 min since track start -> record deleted (stale)
 *
 * HONEST-DATA: every input (price, volumeAcceleration, flow) is measured.
 * Unknown volumeAcceleration or non-dominant flow simply does NOT count as a
 * confirmation — it never invents one.
 */

export interface ContinuationObservation {
  confirmations: number;
  confirmed: boolean;
  /** True when the tracked peak broke down (>4% drawdown) — thesis dead. */
  reset: boolean;
}

interface TrackState {
  mint: string;
  peakPriceUsd: number;
  confirmations: number;
  firstSeenMs: number;
  lastUpdateMs: number;
  lastConfirmMs: number;
  consumed: boolean;
  score: number;
}

/** Pushes required before entry. */
export const CONTINUATION_CONFIRM_BARS = 3;
/** A push must exceed the tracked peak by more than this (filters micro-noise). */
const HIGHER_HIGH_MIN_PCT = 0.5;
/** Drawdown from tracked peak that kills the thesis. */
const CANCEL_DRAWDOWN_PCT = 4.0;
/** Minimum spacing between counted pushes (one push per minute max). */
const MIN_CONFIRM_GAP_MS = 60_000;
/** Tracking expires without progress (avoids stale state across regimes). */
const TRACK_TTL_MS = 45 * 60_000;
/** Continuation pushes need real participation — looser than the 1.5x dip-absorption bar (different setup). */
const VOL_ACCEL_MIN = 1.2;
/** Flow dominance bar mirrors Invalidation 2 (1.35x / imbalance 0.15). */
const FLOW_RATIO_MIN = 1.35;
const FLOW_IMBALANCE_MIN = 0.15;

const tracks = new Map<string, TrackState>();

function flowDominant(buySellRatio: number | undefined, flowImbalance: number): boolean {
  if (buySellRatio === undefined) return flowImbalance >= FLOW_IMBALANCE_MIN;
  return buySellRatio >= FLOW_RATIO_MIN && flowImbalance >= FLOW_IMBALANCE_MIN;
}

export function observeContinuation(
  mint: string,
  priceUsd: number,
  volumeAcceleration: number | undefined,
  buySellRatio: number | undefined,
  flowImbalance: number,
  score: number
): ContinuationObservation {
  const now = Date.now();
  if (!(priceUsd > 0)) return { confirmations: 0, confirmed: false, reset: false };

  let st = tracks.get(mint);
  if (!st) {
    st = {
      mint,
      peakPriceUsd: priceUsd,
      confirmations: 0,
      firstSeenMs: now,
      lastUpdateMs: now,
      lastConfirmMs: 0,
      consumed: false,
      score,
    };
    tracks.set(mint, st);
    return { confirmations: 0, confirmed: false, reset: false };
  }

  // Stale track — regime moved on without us.
  if (now - st.firstSeenMs > TRACK_TTL_MS) {
    tracks.delete(mint);
    return observeContinuation(mint, priceUsd, volumeAcceleration, buySellRatio, flowImbalance, score);
  }

  // Thesis invalidation: peak broke down.
  const drawdownPct = ((st.peakPriceUsd - priceUsd) / st.peakPriceUsd) * 100;
  if (drawdownPct > CANCEL_DRAWDOWN_PCT) {
    tracks.delete(mint);
    return { confirmations: 0, confirmed: false, reset: true };
  }

  st.lastUpdateMs = now;
  st.score = score;

  // Already fired and filled — wait for a reset (breakdown or TTL) before re-arming.
  if (st.consumed) return { confirmations: st.confirmations, confirmed: false, reset: false };
  if (st.confirmations >= CONTINUATION_CONFIRM_BARS) {
    return { confirmations: st.confirmations, confirmed: true, reset: false };
  }

  const risePct = ((priceUsd - st.peakPriceUsd) / st.peakPriceUsd) * 100;
  const volOk = volumeAcceleration !== undefined && volumeAcceleration >= VOL_ACCEL_MIN;
  const timeOk = now - st.lastConfirmMs >= MIN_CONFIRM_GAP_MS;

  if (risePct > HIGHER_HIGH_MIN_PCT && volOk && flowDominant(buySellRatio, flowImbalance) && timeOk) {
    st.confirmations += 1;
    st.peakPriceUsd = priceUsd;
    st.lastConfirmMs = now;
    if (st.confirmations >= CONTINUATION_CONFIRM_BARS) {
      return { confirmations: st.confirmations, confirmed: true, reset: false };
    }
  }
  return { confirmations: st.confirmations, confirmed: false, reset: false };
}

/** Call after a MOMENTUM_CONTINUATION fill so the same track can't re-fire. */
export function markContinuationConsumed(mint: string): void {
  const st = tracks.get(mint);
  if (st) st.consumed = true;
}

/** Explicit cleanup (e.g. position closed, token blacklisted). */
export function clearContinuation(mint: string): void {
  tracks.delete(mint);
}

/** Observability for logs / Telegram. */
export function getContinuationState(mint: string): TrackState | undefined {
  return tracks.get(mint);
}

export function getContinuationTrackCount(): number {
  return tracks.size;
}
