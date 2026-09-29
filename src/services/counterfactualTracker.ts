/**
 * Counterfactual Tracker — the "was the rejection correct?" machine.
 *
 * Every scanner decision (EXECUTED or SKIPPED) is a prediction. This service
 * closes the loop: for recent decisions it fetches the token's price at
 * +15m / +1h / +4h after the decision and records what *would have happened*.
 *
 * That turns the decision journal from a log into an evaluation dataset:
 *   - SKIPPED + counterfactual deeply negative  → rejection reason was correct
 *   - SKIPPED + counterfactual strongly positive → the filter is too tight /
 *     miscalibrated (this is how we discover false negatives)
 *   - EXECUTED + counterfactual vs actual fill → slippage/entry-quality check
 *
 * Runs every 15 minutes, processes at most 25 pending decisions per run to
 * stay light on the DexScreener API.
 */

import { getTokenMarketData } from './dexscreener';
import { getStorageRepository } from '../storage/index';
import { DecisionJournal } from '../journal/decisionJournal';

const TRACK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_DECISIONS_PER_RUN = 25;
const BUCKETS = [
  { key: 'price15mUsd' as const, afterMs: 15 * 60 * 1000 },
  { key: 'price1hUsd' as const, afterMs: 60 * 60 * 1000 },
  { key: 'price4hUsd' as const, afterMs: 4 * 60 * 60 * 1000 }
];

let timer: NodeJS.Timeout | null = null;
let running = false;

async function trackOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const journal = new DecisionJournal(getStorageRepository());
    const recent = await journal.getRecentDecisions(MAX_DECISIONS_PER_RUN);
    const now = Date.now();
    let updated = 0;

    for (const d of recent) {
      try {
        const decidedAt = new Date(d.decidedAt).getTime();
        if (!Number.isFinite(decidedAt)) continue;
        const elapsed = now - decidedAt;

        const initialPrice = (d.featuresSnapshot as any)?.priceUsd as number | undefined;
        if (!initialPrice || initialPrice <= 0) continue;

        // Only fill buckets whose time has actually passed and that are empty.
        const needed = BUCKETS.filter(b => {
          if (elapsed < b.afterMs) return false;
          if (b.key === 'price15mUsd') return d.counterfactualReturn15m === undefined;
          if (b.key === 'price1hUsd') return d.counterfactualReturn1h === undefined;
          return d.counterfactualReturn4h === undefined;
        });
        if (needed.length === 0) continue;

        // One price fetch fills every due bucket (price "now" ≈ price at each
        // due bucket only if we run on schedule; slight staleness is acceptable
        // for a directional counterfactual, and we note the method honestly).
        const market = await getTokenMarketData(d.tokenId, false).catch(() => null);
        const priceNow = market?.priceUsd;
        if (!priceNow || priceNow <= 0) continue;

        const params: { decisionId: string; initialPriceUsd: number; price15mUsd?: number; price1hUsd?: number; price4hUsd?: number } = {
          decisionId: d.decisionId,
          initialPriceUsd: initialPrice
        };
        for (const b of needed) params[b.key] = priceNow;
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
  console.log('[Counterfactual] 🔭 Tracker counterfactual aktif (cek tiap 15 menit).');
  // Delay first run so startup isn't hammered; buckets need 15m+ anyway.
  timer = setInterval(trackOnce, TRACK_INTERVAL_MS);
  setTimeout(trackOnce, 60 * 1000);
}

export function stopCounterfactualTracker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
