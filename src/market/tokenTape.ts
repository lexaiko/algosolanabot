/**
 * TokenTapeTracker — real rolling price/volume tape per token.
 *
 * Hedge-fund rule: never decide on a feature you fabricated. The old scanner
 * derived return1m / return15m / drawdown / wicks algebraically from a single
 * 5-minute DexScreener number — five "features", one degree of freedom.
 *
 * This tape records actual observations over time, fed from two sources:
 *  - marketStreamer WS ticks (tick resolution, watchlist tokens)
 *  - algoScanner snapshots (10-min resolution, every scanned token)
 *
 * Consumers read REAL rolling statistics: peak drawdown, multi-snapshot
 * returns, and true interval volume (delta of 24h volume between snapshots).
 * When the tape is too young, features report null and callers must fall back
 * to conservative defaults — never to invented numbers.
 */

export interface TapePoint {
  t: number; // epoch ms
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
}

export interface TapeFeatures {
  hasTape: boolean;
  points: number;
  spanMinutes: number;
  peakPriceUsd: number;
  /** Real drawdown vs rolling-window peak, % */
  drawdownFromPeakPct: number;
  /** Momentum vs previous observation, % (null when < 2 points).
   *  M2 (2026-09-29): this is the return over `minutesSincePrevPoint` minutes —
   *  NOT a 1-minute return. Consumers MUST divide by minutesSincePrevPoint
   *  (see tapeReturnPerMinutePct) before comparing against per-minute bars. */
  returnSinceLastPct: number | null;
  /** Minutes between the last two tape points (null when < 2 points).
   *  M2: the denominator that turns returnSinceLastPct into a per-minute rate. */
  minutesSincePrevPoint: number | null;
  /** Return vs observation closest to 15 min ago (null when tape < ~12 min) */
  return15mPct: number | null;
  /** Return vs observation closest to 30 min ago (null when tape < ~25 min) */
  return30mPct: number | null;
  /** True interval volume = delta of 24h volume since last observation (null when < 2 points).
   *  M1 (2026-09-29): this delta spans `minutesBetweenVolumePoints` minutes —
   *  NOT 5 minutes. Consumers MUST normalize to a 5-minute equivalent
   *  (see tapeVolume5mNormalized) before annualizing against an hourly baseline. */
  intervalVolumeUsd: number | null;
  /** Minutes between the two volume-carrying observations behind
   *  intervalVolumeUsd (null when unavailable). M1: the normalization denominator. */
  minutesBetweenVolumePoints: number | null;
  /** Real upper-wick ratio over the tape window: (peak - last) / (last - first). Null when no body. */
  upperWickRatio: number | null;
  /** Realized volatility: stdev of per-observation simple returns, in %. Null when < 4 points. */
  realizedVolPct: number | null;
}

const MAX_AGE_MS = 90 * 60 * 1000; // 90-minute rolling window
const MAX_POINTS = 400;

export class TokenTapeTracker {
  private tapes = new Map<string, TapePoint[]>();

  public record(mint: string, priceUsd: number, volume24hUsd: number, liquidityUsd: number): void {
    if (!mint || !(priceUsd > 0)) return;
    let tape = this.tapes.get(mint);
    if (!tape) {
      tape = [];
      this.tapes.set(mint, tape);
    }
    const now = Date.now();
    const last = tape[tape.length - 1];
    // De-dupe: skip if same timestamp ms as last point (WS burst protection)
    if (last && last.t === now) return;
    tape.push({ t: now, priceUsd, volume24hUsd: Math.max(0, volume24hUsd || 0), liquidityUsd: Math.max(0, liquidityUsd || 0) });
    // Prune by age and cap length
    const cutoff = now - MAX_AGE_MS;
    while (tape.length > 0 && tape[0].t < cutoff) tape.shift();
    while (tape.length > MAX_POINTS) tape.shift();
    // Opportunistic map hygiene: drop empty tapes
    if (tape.length === 0) this.tapes.delete(mint);
  }

  public pointCount(mint: string): number {
    return this.tapes.get(mint)?.length || 0;
  }

  private closestBefore(tape: TapePoint[], targetT: number): TapePoint | null {
    let best: TapePoint | null = null;
    for (const p of tape) {
      if (p.t <= targetT) best = p;
      else break;
    }
    return best;
  }

  public getFeatures(mint: string): TapeFeatures {
    const tape = this.tapes.get(mint);
    const empty: TapeFeatures = {
      hasTape: false, points: 0, spanMinutes: 0, peakPriceUsd: 0,
      drawdownFromPeakPct: 0, returnSinceLastPct: null, minutesSincePrevPoint: null,
      return15mPct: null, return30mPct: null, intervalVolumeUsd: null,
      minutesBetweenVolumePoints: null,
      upperWickRatio: null, realizedVolPct: null
    };
    if (!tape || tape.length === 0) return empty;

    const now = Date.now();
    const last = tape[tape.length - 1];
    let peak = 0;
    for (const p of tape) if (p.priceUsd > peak) peak = p.priceUsd;
    const drawdownFromPeakPct = peak > 0 ? Math.max(0, ((peak - last.priceUsd) / peak) * 100) : 0;

    let returnSinceLastPct: number | null = null;
    let minutesSincePrevPoint: number | null = null;
    let intervalVolumeUsd: number | null = null;
    let minutesBetweenVolumePoints: number | null = null;
    if (tape.length >= 2) {
      const prev = tape[tape.length - 2];
      if (prev.priceUsd > 0) {
        returnSinceLastPct = ((last.priceUsd - prev.priceUsd) / prev.priceUsd) * 100;
      }
      // M2: always record the elapsed time behind the return, even when the
      // return itself is uncomputable — consumers fail closed on missing data.
      if (last.t > prev.t) minutesSincePrevPoint = (last.t - prev.t) / 60000;
    }
    // True interval flow: delta of 24h volume between the two most recent
    // observations that actually carried volume data. WS ticks don't report
    // volume (volume24hUsd = 0) — they are skipped, never treated as zero flow.
    // (DexScreener 24h volume is a rolling sum; its delta ≈ volume in the interval.)
    {
      let a: TapePoint | null = null;
      for (let i = tape.length - 1; i >= 0 && !a; i--) {
        if (tape[i].volume24hUsd > 0) a = tape[i];
      }
      if (a) {
        let b: TapePoint | null = null;
        for (let i = tape.indexOf(a) - 1; i >= 0 && !b; i--) {
          if (tape[i].volume24hUsd > 0) b = tape[i];
        }
        if (b && a.t > b.t) {
          intervalVolumeUsd = Math.max(0, a.volume24hUsd - b.volume24hUsd);
          // M1: the elapsed minutes behind the delta — the 5-minute
          // normalization denominator. Without it the delta was mislabeled
          // as 5-minute volume and annualized x12 (2x inflated on 10m scans).
          minutesBetweenVolumePoints = (a.t - b.t) / 60000;
        }
      }
    }

    const spanMinutes = (now - tape[0].t) / 60000;
    let return15mPct: number | null = null;
    let return30mPct: number | null = null;
    if (spanMinutes >= 12) {
      const ref = this.closestBefore(tape, now - 15 * 60 * 1000);
      if (ref && ref.priceUsd > 0 && ref !== last) {
        return15mPct = ((last.priceUsd - ref.priceUsd) / ref.priceUsd) * 100;
      }
    }
    if (spanMinutes >= 25) {
      const ref = this.closestBefore(tape, now - 30 * 60 * 1000);
      if (ref && ref.priceUsd > 0 && ref !== last) {
        return30mPct = ((last.priceUsd - ref.priceUsd) / ref.priceUsd) * 100;
      }
    }

    return {
      hasTape: true,
      points: tape.length,
      spanMinutes: Math.round(spanMinutes * 10) / 10,
      peakPriceUsd: peak,
      drawdownFromPeakPct: Math.round(drawdownFromPeakPct * 100) / 100,
      returnSinceLastPct: returnSinceLastPct !== null ? Math.round(returnSinceLastPct * 100) / 100 : null,
      minutesSincePrevPoint: minutesSincePrevPoint !== null ? Math.round(minutesSincePrevPoint * 100) / 100 : null,
      return15mPct: return15mPct !== null ? Math.round(return15mPct * 100) / 100 : null,
      return30mPct: return30mPct !== null ? Math.round(return30mPct * 100) / 100 : null,
      intervalVolumeUsd: intervalVolumeUsd !== null ? Math.round(intervalVolumeUsd) : null,
      minutesBetweenVolumePoints: minutesBetweenVolumePoints !== null ? Math.round(minutesBetweenVolumePoints * 100) / 100 : null,
      upperWickRatio: computeWickRatio(tape, peak, last.priceUsd),
      realizedVolPct: computeRealizedVol(tape)
    };
  }

  /** Drop a token's tape (e.g. after position close — frees memory). */
  public drop(mint: string): void {
    this.tapes.delete(mint);
  }

  /**
   * 2026-09-30 (supervisor): serializable snapshot of all tapes for
   * crash-resilience. Points older than MAX_AGE_MS are dropped — the file
   * stays small and only decision-relevant history is kept. Returns a deep
   * copy; mutating the result never affects live tapes.
   */
  public snapshot(): Record<string, TapePoint[]> {
    const now = Date.now();
    const cutoff = now - MAX_AGE_MS;
    const out: Record<string, TapePoint[]> = {};
    for (const [mint, tape] of this.tapes) {
      const fresh = tape.filter(p => p.t >= cutoff && p.priceUsd > 0);
      if (fresh.length > 0) out[mint] = fresh.map(p => ({ ...p }));
    }
    return out;
  }

  /**
   * 2026-09-30 (supervisor): restore tapes from a snapshot (e.g. after a
   * SIGKILL restart). Every point is re-validated: bad shapes, non-positive
   * prices, and points older than MAX_AGE_MS are discarded, per-mint length
   * is capped at MAX_POINTS. Restored points keep their ORIGINAL timestamps —
   * features derived from them (span, returns, drawdown) stay honest about
   * their age. Returns the number of mints restored.
   */
  public restore(data: Record<string, TapePoint[]>): number {
    if (!data || typeof data !== 'object') return 0;
    const now = Date.now();
    const cutoff = now - MAX_AGE_MS;
    let restored = 0;
    for (const [mint, points] of Object.entries(data)) {
      if (!mint || !Array.isArray(points) || points.length === 0) continue;
      const clean: TapePoint[] = [];
      for (const p of points) {
        if (
          p && typeof p.t === 'number' && Number.isFinite(p.t) &&
          p.t >= cutoff && p.t <= now + 60000 &&
          typeof p.priceUsd === 'number' && p.priceUsd > 0
        ) {
          clean.push({
            t: Math.floor(p.t),
            priceUsd: p.priceUsd,
            volume24hUsd: typeof p.volume24hUsd === 'number' && p.volume24hUsd > 0 ? p.volume24hUsd : 0,
            liquidityUsd: typeof p.liquidityUsd === 'number' && p.liquidityUsd > 0 ? p.liquidityUsd : 0
          });
        }
      }
      if (clean.length === 0) continue;
      clean.sort((a, b) => a.t - b.t);
      const capped = clean.slice(-MAX_POINTS);
      // Merge with any live tape (e.g. ticks that arrived before restore ran)
      const live = this.tapes.get(mint);
      if (live && live.length > 0) {
        const seen = new Set(live.map(p => p.t));
        for (const p of capped) if (!seen.has(p.t)) live.push(p);
        live.sort((a, b) => a.t - b.t);
        while (live.length > MAX_POINTS) live.shift();
      } else {
        this.tapes.set(mint, capped);
      }
      restored++;
    }
    return restored;
  }

  /**
   * Price of the tape point closest to targetMs, or null when no point falls
   * within toleranceMs. Used by the counterfactual tracker to recover honest
   * decision-time and horizon prices from real observations — never invented.
   */
  public priceClosestTo(mint: string, targetMs: number, toleranceMs: number): number | null {
    const tape = this.tapes.get(mint);
    if (!tape || tape.length === 0) return null;
    let best: TapePoint | null = null;
    let bestDist = Infinity;
    for (const p of tape) {
      const dist = Math.abs(p.t - targetMs);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    if (!best || bestDist > toleranceMs || !(best.priceUsd > 0)) return null;
    return best.priceUsd;
  }

  public size(): number {
    return this.tapes.size;
  }
}

/**
 * Real upper-wick ratio over the tape window: (windowPeak - lastClose) / (lastClose - windowOpen).
 * > 0.40 with a positive body = distribution into strength (dev/insider selling the top).
 * Returns null when there is no measurable body — callers must SKIP the wick
 * guard in that case, never invent a rejection.
 */
function computeWickRatio(tape: TapePoint[], peak: number, lastPrice: number): number | null {
  if (tape.length < 3 || peak <= 0) return null;
  const open = tape[0].priceUsd;
  if (!(open > 0)) return null;
  const body = lastPrice - open;
  if (body <= 0) return null; // red/flat window: no "upper wick" concept
  const wick = Math.max(0, peak - lastPrice);
  return Math.round((wick / body) * 100) / 100;
}

/**
 * Realized volatility from the tape: sample stdev of per-observation simple
 * returns, in percent. Needs >= 4 points to be meaningful.
 */
function computeRealizedVol(tape: TapePoint[]): number | null {
  if (tape.length < 4) return null;
  const rets: number[] = [];
  for (let i = 1; i < tape.length; i++) {
    const prev = tape[i - 1].priceUsd;
    const cur = tape[i].priceUsd;
    if (prev > 0 && cur > 0) rets.push((cur - prev) / prev);
  }
  if (rets.length < 3) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1);
  return Math.round(Math.sqrt(variance) * 100 * 100) / 100;
}

export const tokenTape = new TokenTapeTracker();

/**
 * M1 (2026-09-29): normalize the tape's interval volume to a 5-minute
 * equivalent using the ACTUAL elapsed minutes between the two volume-carrying
 * observations. Returns null when the tape cannot measure it — callers fail
 * closed (C4), never annualize an un-normalized delta.
 */
export function tapeVolume5mNormalized(tape: TapeFeatures): number | null {
  if (
    tape.intervalVolumeUsd === null ||
    tape.minutesBetweenVolumePoints === null ||
    tape.minutesBetweenVolumePoints <= 0
  ) {
    return null;
  }
  return Math.round(tape.intervalVolumeUsd * (5 / tape.minutesBetweenVolumePoints));
}

/**
 * M2 (2026-09-29): per-minute rebound rate (%/min) = returnSinceLastPct divided
 * by the ACTUAL minutes since the previous tape point. Returns null when
 * unmeasurable — R4 fails closed (reject) on null.
 */
export function tapeReturnPerMinutePct(tape: TapeFeatures): number | null {
  if (
    tape.returnSinceLastPct === null ||
    tape.minutesSincePrevPoint === null ||
    tape.minutesSincePrevPoint <= 0
  ) {
    return null;
  }
  return Math.round((tape.returnSinceLastPct / tape.minutesSincePrevPoint) * 100) / 100;
}
