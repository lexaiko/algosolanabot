import { CONFIG } from './config';
import { initDatabase, getPaperBalance } from './db/index';
import { bot } from './bot/telegram';
import { startPositionManager, stopPositionManager } from './services/tradeManager';
import { startAlgoScanner, stopAlgoScanner } from './services/algoScanner';
import { startMarketStreamer, stopMarketStreamer } from './services/marketStreamer';

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
// Process-level safety nets (fail-LOUD, never silent):
// Floating promises (e.g. inside WebSocket callbacks) and stray throws used to
// crash the bot with no diagnostics. These handlers LOG the error clearly and
// keep the process alive — they do NOT swallow: every event is surfaced with
// a redacted stack so we can diagnose feed/WS deaths without leaking secrets.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason: any) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[Process] ⚠️ UNHANDLED REJECTION (process kept alive):', err.message);
  console.error('[Process] Stack:', redactStack(err.stack));
});

process.on('uncaughtException', (err: Error) => {
  console.error('[Process] 🚨 UNCAUGHT EXCEPTION (process kept alive):', err.message);
  console.error('[Process] Stack:', redactStack(err.stack));
});

async function main() {
  console.log('====================================================');
  console.log(' 🚀 SOLANA QUANTITATIVE ALGORITHMIC TRADING BOT    ');
  console.log(' 🏛️ INSTITUTIONAL HEDGE FUND SURVIVAL ENGINE        ');
  console.log('====================================================');

  // 1. Initialize SQLite Database
  initDatabase();
  console.log(`[DB] Database initialized successfully. Paper Balance: ${getPaperBalance().toFixed(3)} SOL`);

  // 2. Start Quantitative Execution Engines (Zero-Polling Event-Driven WebSocket First)
  startPositionManager();
  await startMarketStreamer();
  startAlgoScanner();

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

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[System] Shutting down cleanly...');
    stopPositionManager();
    stopMarketStreamer();
    stopAlgoScanner();
    try { bot.stop(); } catch {}
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal Error]:', err);
  process.exit(1);
});
