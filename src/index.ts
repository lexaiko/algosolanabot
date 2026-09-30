// MUST be first: patches the `ws` module for egress-proxy environments before
// @solana/web3.js or marketStreamer load it. No-op when no proxy is configured.
import './utils/netProxy';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { setAutonomousBuyEnabled } from './core/autonomy';
import { initDatabase, getPaperBalance } from './db/index';
import { bot, sendAdminAlert, startAlertOutboxFlusher } from './bot/telegram';
import { startPositionManager, stopPositionManager } from './services/tradeManager';
import { startAlgoScanner, stopAlgoScanner } from './services/algoScanner';
import { startMarketStreamer, stopMarketStreamer } from './services/marketStreamer';
import { startCounterfactualTracker, stopCounterfactualTracker } from './services/counterfactualTracker';
import { restoreTapeSnapshot, startTapeAutosave, stopTapeAutosave, saveTapeSnapshot } from './market/tapePersistence';

/**
 * REDACTED stack formatter:
 * Scraps wallet keys / API keys / tokens from the stack trace before logging,
 * so crash diagnostics never leak secrets to stdout or Telegram.
 */
function redactStack(stack: string | undefined): string {
  if (!stack) return '<no stack>';
  return stack
    // Helius / RPC URLs with api-key=…
    .replace(/api-key=[A-Za-z0-9_-]+/gi, 'api-key=<REDACTED>')
    // Base58 Solana private keys / addresses (>=32 chars) embedded in frames
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, (m) => `${m.slice(0, 4)}…<REDACTED>`)
    // Telegram bot tokens (NNNNNN:AA…)
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '<REDACTED_TOKEN>');
}

// ---------------------------------------------------------------------------
// O-01b: singleton PID guard. Two bot instances sharing one SQLite file means
// SQLITE_BUSY crashes, double-buys and double-sells. The watchdog's atomic
// flock is the first defense; this is the in-process second defense: a second
// instance exits(1) loudly instead of running alongside the first.
// ---------------------------------------------------------------------------
const LOCK_PATH = path.resolve(process.cwd(), 'tradingbot.lock');

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockPid(): number {
  try {
    return parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function isPidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingletonLock(): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx'); // exclusive create — atomic at OS level
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      console.log(`[System] 🔒 Singleton lock acquired (${LOCK_PATH}, pid ${process.pid}).`);
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }
    // Lock file exists: identify the owner. A concurrent starter may not have
    // written its PID yet — wait briefly and re-read before concluding.
    sleepSync(1500);
    const ownerPid = readLockPid();
    if (ownerPid > 0 && isPidAlive(ownerPid)) {
      console.error(
        `[System] 🛑 FATAL: another bot instance is already running (pid ${ownerPid}). ` +
        `Refusing to double-start — two instances would corrupt tradingbot.db and double-trade. ` +
        `If this is wrong, stop the other instance or delete ${LOCK_PATH}.`
      );
      process.exit(1);
    }
    if (ownerPid > 0) {
      console.warn(`[System] ⚠️ Stale lock found (pid ${ownerPid} dead). Removing and re-acquiring.`);
    } else {
      console.warn('[System] ⚠️ Lock file exists but owner PID unreadable after wait. Removing stale lock.');
    }
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  }
  console.error(
    '[System] 🛑 FATAL: could not acquire singleton lock after 3 attempts. ' +
    'Another instance may be starting concurrently — refusing to risk a double-start.'
  );
  process.exit(1);
}

function releaseSingletonLock(): void {
  try {
    if (readLockPid() === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {}
}

// ---------------------------------------------------------------------------
// O-07: health file. The event loop writes a timestamp every 30s; the watchdog
// treats a health file older than 3 minutes as DEAD even if the process still
// shows up in pgrep (zombie with a wedged event loop / dead WS feeds).
// ---------------------------------------------------------------------------
const HEALTH_PATH = path.resolve(process.cwd(), 'bot.health');
let heartbeatTimer: NodeJS.Timeout | null = null;

function startHeartbeat(): void {
  const beat = () => {
    try {
      fs.writeFileSync(HEALTH_PATH, JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        uptimeSec: Math.round(process.uptime())
      }));
    } catch {}
  };
  beat();
  heartbeatTimer = setInterval(beat, 30 * 1000);
  console.log('[System] 💓 Health heartbeat aktif (bot.health tiap 30 dtk).');
}

// ---------------------------------------------------------------------------
// NET-RESILIENCE (2026-09-29): memory guard. Kematian diam-diam 29 Sep 2026
// (heartbeat berhenti tanpa exception/log — kemungkinan OOM saat egress down
// dan re-subscribe churn) tidak boleh terulang tanpa jejak. Kalau memori
// mendekati batas, mati BERISIK via fatalShutdown supaya watchdog restart
// bersih, bukan dibunuh kernel tanpa alert.
// Dipantau RSS (bukan cuma heap): socket/TLS/proxy buffer bocor di native
// tidak terlihat di heapUsed tapi membunuh via OOM killer.
// ---------------------------------------------------------------------------
const RSS_WARN_BYTES = 1536 * 1024 * 1024; // 1.5 GB
const RSS_FATAL_BYTES = 2048 * 1024 * 1024; // 2 GB
const HEAP_WARN_BYTES = 1024 * 1024 * 1024; // 1 GB
const HEAP_FATAL_BYTES = Math.floor(HEAP_WARN_BYTES * 1.5); // 1.5 GB
let heapGuardTimer: NodeJS.Timeout | null = null;
let memWarned = false;

function startHeapGuard(): void {
  const check = () => {
    try {
      const { rss, heapUsed } = process.memoryUsage();
      const rssMb = Math.round(rss / 1048576);
      const heapMb = Math.round(heapUsed / 1048576);
      if (rss >= RSS_FATAL_BYTES || heapUsed >= HEAP_FATAL_BYTES) {
        fatalShutdown(
          `Memori kritis (RSS ${rssMb} MB / heap ${heapMb} MB) — indikasi leak/OOM, restart bersih.`
        );
      } else if ((rss >= RSS_WARN_BYTES || heapUsed >= HEAP_WARN_BYTES) && !memWarned) {
        memWarned = true;
        console.warn(
          `[System] ⚠️ Memori tinggi: RSS ${rssMb} MB / heap ${heapMb} MB — pantau, mendekati batas restart.`
        );
      } else if (rss < RSS_WARN_BYTES && heapUsed < HEAP_WARN_BYTES) {
        memWarned = false;
      }
    } catch {}
  };
  heapGuardTimer = setInterval(check, 60 * 1000);
  if (heapGuardTimer.unref) heapGuardTimer.unref();
  console.log('[System] 🛡️ Memory guard aktif (RSS warn 1.5GB/restart 2GB, heap warn 1GB/restart 1.5GB).');
}

/** Best-effort fatal alert, then die so the watchdog restarts a clean process. */
function fatalShutdown(message: string): void {
  console.error(message);
  try {
    // Queued to the outbox when the direct send fails — the replacement
    // instance's flusher will deliver it.
    sendAdminAlert(`🛑 *BOT FATAL:* ${message}`).catch(() => {});
  } catch {}
  setTimeout(() => process.exit(1), 2000);
}

// ---------------------------------------------------------------------------
// Process-level safety nets (fail-LOUD, never silent):
// O-07 (2026-09-29): the old handlers LOGGED and kept the process alive, so a
// corrupted state (dead WS streamer, throwing heartbeat) became a zombie the
// watchdog considered "healthy" forever. Now: uncaughtException dies loudly
// (watchdog restarts us); unhandledRejection is tolerated up to 5x, then dies.
// ---------------------------------------------------------------------------
let unhandledRejectionCount = 0;
process.on('unhandledRejection', (reason: any) => {
  unhandledRejectionCount++;
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`[Process] ⚠️ UNHANDLED REJECTION #${unhandledRejectionCount}:`, err.message);
  console.error('[Process] Stack:', redactStack(err.stack));
  if (unhandledRejectionCount >= 5) {
    fatalShutdown(
      `[Process] 5 unhandled rejections — process state may be corrupt. Exiting for watchdog restart.`
    );
  }
});

process.on('uncaughtException', (err: Error) => {
  console.error('[Process] 🚨 UNCAUGHT EXCEPTION:', err.message);
  console.error('[Process] Stack:', redactStack(err.stack));
  fatalShutdown(`[Process] Uncaught exception (${err.message}) — exiting for watchdog restart.`);
});

async function main() {
  console.log('====================================================');
  console.log(' 🚀 SOLANA QUANTITATIVE ALGORITHMIC TRADING BOT    ');
  console.log(' 🏛️ INSTITUTIONAL HEDGE FUND SURVIVAL ENGINE        ');
  console.log('====================================================');

  // 0. Singleton guard — refuse to run as a second instance (O-01b).
  acquireSingletonLock();

  // O-10: no admin = zero oversight. Disable autonomous buying fail-closed.
  // Manual Telegram trading (explicit user confirmation) keeps working.
  if (!CONFIG.TELEGRAM_ADMIN_ID) {
    console.error(
      '[System] 🛑 FATAL (O-10): TELEGRAM_ADMIN_ID belum diisi/deteksi — ' +
      'AUTONOMOUS BUY DINONAKTIFKAN (fail-closed). Trading manual via Telegram tetap jalan. ' +
      'Isi ID admin numerik di .env lalu restart untuk mengaktifkan trading otonom.'
    );
    setAutonomousBuyEnabled(false, 'TELEGRAM_ADMIN_ID belum diisi — nol oversight');
  }

  // 1. Initialize SQLite Database
  initDatabase();
  console.log(`[DB] Database initialized successfully. Paper Balance: ${getPaperBalance().toFixed(3)} SOL`);

  startAlertOutboxFlusher();
  startHeartbeat();
  startHeapGuard();

  // 2026-09-30 (supervisor): restore tape snapshot BEFORE engines start, so
  // the first scan cycle already has history (no ~10 min blind window after
  // a SIGKILL restart). Stale/corrupt snapshots are discarded fail-closed.
  restoreTapeSnapshot();

  // 2. Start Quantitative Execution Engines (Zero-Polling Event-Driven WebSocket First)
  startPositionManager();
  await startMarketStreamer();
  startAlgoScanner();
  startTapeAutosave(); // snapshot tape tiap 60 dtk — batas data hilang saat SIGKILL
  startCounterfactualTracker(); // Validasi "apakah penolakan/eksekusi scanner benar?"

  // 3. Start Telegram Bot with Resilient Auto-Retry Loop
  async function startTelegramWithRetry() {
    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
      console.warn('\n⚠️ [Telegram] PERINGATAN: TELEGRAM_BOT_TOKEN belum diatur di file .env.');
      console.warn('👉 Buat bot baru di https://t.me/BotFather, salin tokennya, lalu masukkan ke file .env.\n');
      return;
    }

    let delayMs = 3000;
    let attempt = 0;

    while (true) {
      attempt++;
      try {
        const me = await bot.telegram.getMe();
        console.log(`[Telegram] 🤖 Bot online: @${me.username} (${me.first_name})`);

        await bot.launch({ dropPendingUpdates: true });
        console.log(`[Telegram] 🚀 Polling aktif. Bot siap menerima sinyal & perintah di Telegram!`);

        // O-09 self-test + O-12 restart notice: prove the Telegram path works
        // AND tell the admin that updates sent during the restart were dropped
        // (dropPendingUpdates) so a lost cut-loss command gets re-issued.
        await sendAdminAlert(
          `🤖 *Bot online* — ${CONFIG.PAPER_TRADING ? 'PAPER TRADING' : '⚠️ LIVE TRADING'} (self-test notifikasi ✅)\n\n` +
          `🔄 Bot baru saja (re)start — perintah Telegram yang masuk tepat saat restart *dibuang otomatis* dan tidak tereksekusi. ` +
          `_Silakan ulangi perintah terakhir (mis. konfirmasi jual) bila belum tereksekusi._`
        ).catch(() => {});
        break;
      } catch (err: any) {
        console.error(`[Telegram] ⚠️ Koneksi Telegram gagal (Percobaan #${attempt}): ${err.message}. Mencoba lagi dalam ${Math.round(delayMs / 1000)}s...`);
        await new Promise(res => setTimeout(res, delayMs));
        delayMs = Math.min(delayMs * 1.5, 30000);
      }
    }
  }

  startTelegramWithRetry().catch((err) => {
    console.error('[Telegram] Launcher error:', err);
  });

  // Graceful shutdown (O-22: await bot.stop so in-flight polling settles;
  // release the singleton lock so the watchdog can start a fresh instance).
  const shutdown = async () => {
    console.log('\n[System] Shutting down cleanly...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (heapGuardTimer) clearInterval(heapGuardTimer);
    stopTapeAutosave();
    saveTapeSnapshot(); // final tape snapshot — restart berikutnya langsung punya history
    stopPositionManager();
    stopMarketStreamer();
    await stopAlgoScanner(); // O-20: async — waits for in-flight scan cycle so no buy fires mid-shutdown
    stopCounterfactualTracker();
    try { await bot.stop(); } catch {}
    await new Promise(res => setTimeout(res, 500));
    releaseSingletonLock();
    process.exit(0);
  };

  process.once('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
  process.once('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });
}

main().catch((err) => {
  console.error('[Fatal Error]:', err);
  process.exit(1);
});
