import { CONFIG } from './config';
import { initDatabase, getPaperBalance } from './db/index';
import { bot } from './bot/telegram';
import { startPositionManager, stopPositionManager } from './services/tradeManager';
import { startAlgoScanner, stopAlgoScanner } from './services/algoScanner';
import { startMarketStreamer, stopMarketStreamer } from './services/marketStreamer';

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
