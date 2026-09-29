/**
 * Counterfactual Tracker — the "was the rejection correct?" machine.
 *
 * Every scanner decision (EXECUTED or SKIPPED) is a prediction. This service
 * closes the loop: for recent decisions it records the token's price at
 * +15m / +1h / +4h after the decision and stores what *would have happened*.
 *
 * That turns the decision journal from a log into an evaluation dataset:
 *   - SKIPPED + counterfactual deeply negative  → rejection reason was correct
 *   - SKIPPED + counterfactual strongly positive → the filter is too tight /
 *     miscalibrated (this is how we discover false negatives)
 *   - EXECUTED + counterfactual vs actual fill → slippage/entry-quality check
 *
 * HONEST-DATA RULES (2026-09-29 rewrite):
 *   1. A horizon bucket is filled ONLY from a price observed near its target
 *      time. Filling a +15m bucket with a price seen 3h late (e.g. after
 *      downtime) fabricates an outcome — worse than no data. Missed windows
 *      stay NULL, permanently. A gap in the dataset is honest; a fabricated
 *      point poisons every falsification test built on it.
 *   2. Decision-time price comes from the snapshot (producers now set
 *      priceUsd) with a token-tape fallback. The old code read
 *      featuresSnapshot.priceUsd which producers never set → 0/446 filled.
 *   3. Horizon prices prefer the token tape (real observations at the right
 *      timestamps) over a live fetch.
 *
 * Runs every 15 minutes, processes at most 25 pending decisions per run to
 * stay light on the DexScreener API.
 */

import { getTokenMarketData } from './dexscreener';
import { getStorageRepository } from '../storage/index';
import { DecisionJournal } from '../journal/decisionJournal';
import { tokenTape } from '../market/tokenTape';

const TRACK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_DECISIONS_PER_RUN = 25;
/** Max lateness for a horizon observation. Beyond this the window is missed. */
const BUCKET_GRACE_MS = 20 * 60 * 1000;
/** Tape lookup tolerance around a target timestamp. */
const TAPE_TOLERANCE_MS = 7 * 60 * 1000;
const DECISION_PRICE_TOLERANCE_MS = 5 * 60 * 1000;

const BUCKETS = [
  { key: 'price15mUsd' as const, afterMs: 15 * 60 * 1000, useTape: true },
  { key: 'price1hUsd' as const, afterMs: 60 * 60 * 1000, useTape: true },
  { key: 'price4hUsd' as const, afterMs: 4 * 60 * 60 * 1000, useTape: false }
];

let timer: NodeJS.Timeout | null = null;
let initialTimeout: NodeJS.Timeout | null = null;
let running = false;

async function trackOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const journal = new DecisionJournal(getStorageRepository());
    // O-18: FIFO, not "25 latest". getRecentDecisions returns newest-first, so
    // the oldest pending decisions used to starve when the scanner logged
    // dozens of decisions per cycle. Fetch a wider window, sort oldest-first,
    // and work the queue in decision order.
    const recent = await journal.getRecentDecisions(150);
    recent.sort((a, b) => new Date(a.decidedAt).getTime() - new Date(b.decidedAt).getTime());
    const now = Date.now();
    let updated = 0;

    for (const d of recent) {
      if (updated >= MAX_DECISIONS_PER_RUN) break;
      try {
        const decidedAt = new Date(d.decidedAt).getTime();
        if (!Number.isFinite(decidedAt)) continue;
        const elapsed = now - decidedAt;

        // Decision-time price: snapshot first, tape fallback. Skip when
        // neither knows — no price, no counterfactual (never invented).
        const snapPrice = (d.featuresSnapshot as any)?.priceUsd as number | undefined;
        const initialPrice = (snapPrice && snapPrice > 0)
          ? snapPrice
          : tokenTape.priceClosestTo(d.tokenId, decidedAt, DECISION_PRICE_TOLERANCE_MS);
        if (!initialPrice || initialPrice <= 0) continue;

        // A bucket is eligible only when its target time has passed, we are
        // still inside the grace window, and it is empty (null OR undefined —
        // SQLite returns null for unset columns).
        const needed = BUCKETS.filter(b => {
          if (elapsed < b.afterMs || elapsed > b.afterMs + BUCKET_GRACE_MS) return false;
          if (b.key === 'price15mUsd') return d.counterfactualReturn15m == null;
          if (b.key === 'price1hUsd') return d.counterfactualReturn1h == null;
          return d.counterfactualReturn4h == null;
        });
        if (needed.length === 0) continue;

        // Tape-first: real observations near each horizon timestamp.
        const prices = new Map<string, number>();
        for (const b of needed) {
          if (!b.useTape) continue;
          const p = tokenTape.priceClosestTo(d.tokenId, decidedAt + b.afterMs, TAPE_TOLERANCE_MS);
          if (p && p > 0) prices.set(b.key, p);
        }

        // Single live fetch for whatever the tape couldn't cover. This price
        // is "now", which is inside the grace window for every needed bucket
        // by the filter above — close enough to be honest, never hours late.
        const missing = needed.filter(b => !prices.has(b.key));
        if (missing.length > 0) {
          const market = await getTokenMarketData(d.tokenId, false).catch(() => null);
          const live = market?.priceUsd;
          if (live && live > 0) {
            for (const b of missing) prices.set(b.key, live);
          }
        }

        if (prices.size === 0) continue;
        const params: {
          decisionId: string; initialPriceUsd: number;
          price15mUsd?: number; price1hUsd?: number; price4hUsd?: number;
        } = { decisionId: d.decisionId, initialPriceUsd: initialPrice };
        for (const b of needed) {
          const p = prices.get(b.key);
          if (p && p > 0) (params as any)[b.key] = p;
        }
        await journal.updateCounterfactual(params);
        updated++;
      } catch {}
    }

    if (updated > 0) {
      console.log(`[Counterfactual] 📊 Mencatat outcome ${updated} keputusan scanner (validasi penolakan/eksekusi).`);
    }
  } catch (err: any) {
    console.log(`[Counterfactual] ⚠️ Gagal: ${err?.message || err}`);
  } finally {
    running = false;
  }
}

export function startCounterfactualTracker(): void {
  if (timer) return;
  console.log('[Counterfactual] 🔭 Tracker counterfactual aktif (cek tiap 15 menit, FIFO).');
  // Delay first run so startup isn't hammered; buckets need 15m+ anyway.
  timer = setInterval(trackOnce, TRACK_INTERVAL_MS);
  initialTimeout = setTimeout(trackOnce, 60 * 1000);
}

export function stopCounterfactualTracker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // O-18: cancel the delayed first run — otherwise trackOnce can fire once
  // AFTER shutdown, doing API work against a torn-down process.
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
}
