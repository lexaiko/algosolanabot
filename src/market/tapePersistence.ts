/**
 * tapePersistence — crash-resilient tape snapshots.
 *
 * 2026-09-30 (supervisor): the bot dies silently every few hours (external
 * SIGKILL — RSS flat, proxy healthy; nothing catchable in-process). Each
 * restart used to cost ~10 minutes of blind scanning because the tape
 * (TokenTapeTracker) rebuilt from zero: return15m/return30m/realizedVol need
 * 12–25 minutes of history before they unlock.
 *
 * This module snapshots the tape to disk every 60s (atomic tmp+rename) and
 * restores it on boot when the snapshot is fresh (< 10 min old). Restored
 * points keep their ORIGINAL timestamps, so every derived feature stays
 * honest about its age — a 9-minute-old snapshot gives spanMinutes ≈ 9, and
 * return15m unlocks ~3 minutes after boot instead of ~12.
 *
 * Freshness gate: a snapshot older than 10 minutes is discarded — the market
 * moved too far for the history to be decision-relevant. Fail-closed: any
 * read/parse/validation error → start with an empty tape, never a corrupt one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { tokenTape, TapePoint } from './tokenTape';

const SNAPSHOT_DIR = path.resolve(process.cwd(), 'hidden_files');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'tape-snapshot.json');
const SNAPSHOT_TMP_PATH = SNAPSHOT_PATH + '.tmp';
/** Max snapshot age to trust on restore — ~one scan cycle. */
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
/** Autosave cadence — bounds data loss on SIGKILL to ~60s of ticks. */
const AUTOSAVE_INTERVAL_MS = 60 * 1000;

interface TapeSnapshotFile {
  savedAt: number;
  tapes: Record<string, TapePoint[]>;
}

/** Write the current tape to disk atomically. Never throws. */
export function saveTapeSnapshot(): boolean {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const payload: TapeSnapshotFile = {
      savedAt: Date.now(),
      tapes: tokenTape.snapshot()
    };
    fs.writeFileSync(SNAPSHOT_TMP_PATH, JSON.stringify(payload));
    fs.renameSync(SNAPSHOT_TMP_PATH, SNAPSHOT_PATH);
    return true;
  } catch (err) {
    console.warn(`[TapePersistence] ⚠️ Gagal menyimpan snapshot tape: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Restore the tape from disk when the snapshot is fresh.
 * Returns the number of mints restored (0 = skipped/failed/empty).
 * Never throws.
 */
export function restoreTapeSnapshot(): number {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return 0;
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as TapeSnapshotFile;
    if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.tapes || typeof parsed.tapes !== 'object') {
      console.warn('[TapePersistence] ⚠️ Snapshot tape korup — mulai dengan tape kosong.');
      return 0;
    }
    const ageMs = Date.now() - parsed.savedAt;
    if (ageMs < 0 || ageMs > SNAPSHOT_MAX_AGE_MS) {
      console.log(`[TapePersistence] ℹ️ Snapshot tape terlalu tua (${Math.round(ageMs / 60000)} mnt) — mulai fresh.`);
      return 0;
    }
    const n = tokenTape.restore(parsed.tapes);
    if (n > 0) {
      console.log(`[TapePersistence] ✅ Tape direstore: ${n} token, snapshot umur ${Math.round(ageMs / 1000)} dtk.`);
    }
    return n;
  } catch (err) {
    console.warn(`[TapePersistence] ⚠️ Gagal restore snapshot tape: ${(err as Error).message} — mulai fresh.`);
    return 0;
  }
}

let autosaveTimer: NodeJS.Timeout | null = null;

/** Start periodic autosave. Idempotent. Returns a stop function. */
export function startTapeAutosave(): () => void {
  if (autosaveTimer) return stopTapeAutosave;
  autosaveTimer = setInterval(() => {
    saveTapeSnapshot();
  }, AUTOSAVE_INTERVAL_MS);
  // Don't hold the process open on this timer alone (shutdown clears it anyway).
  if (typeof (autosaveTimer as any).unref === 'function') (autosaveTimer as any).unref();
  console.log('[TapePersistence] 💾 Autosave tape tiap 60 dtk aktif.');
  return stopTapeAutosave;
}

export function stopTapeAutosave(): void {
  if (autosaveTimer) {
    clearInterval(autosaveTimer);
    autosaveTimer = null;
  }
}
