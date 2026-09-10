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

  // 3. Start Telegram Bot
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    console.warn('\n⚠️ [Telegram] PERINGATAN: TELEGRAM_BOT_TOKEN belum diatur di file .env.');
    console.warn('👉 Buat bot baru di https://t.me/BotFather, salin tokennya, lalu masukkan ke file .env.\n');
  } else {
    try {
      const me = await bot.telegram.getMe();
      console.log(`[Telegram] 🤖 Bot online: @${me.username} (${me.first_name})`);
      
      // Start polling non-blocking
      bot.launch({ dropPendingUpdates: true }).catch((err) => {
        console.error('[Telegram] Polling error:', err.message);
      });
      console.log(`[Telegram] 🚀 Polling aktif. Bot siap menerima sinyal & perintah di Telegram!`);
    } catch (err: any) {
      console.error('[Telegram] ❌ Gagal menghubungkan bot Telegram:', err.message);
      console.warn('Pastikan TELEGRAM_BOT_TOKEN di .env sudah valid.');
    }
  }

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
