import { Telegraf, Markup } from 'telegraf';
import { CONFIG } from '../config';
import {
  getPaperBalance,
  resetPaperBalance,
  getOpenPositions,
  getTradeHistory,
  getTradingStats,
  getDailyRealizedPnl,
  isCircuitBreakerActive,
  resetCircuitBreaker,
  getPortfolioQuantMetrics,
  addWatcher,
  removeWatcher,
  isWatcher,
  getWatchers
} from '../db/index';
import { getSolPriceUsd, getTokenMarketData } from '../services/dexscreener';
import { checkTokenSafety } from '../services/antirug';
import { executeBuyToken, executeSellToken, setTelegramNotifier } from '../services/tradeManager';
import { scanMarketOnce, setAlgoScannerNotifier } from '../services/algoScanner';
import {
  fetchHistoricalCandles,
  generateSyntheticRegime,
  runBacktest,
  formatBacktestTelegramReport
} from '../services/backtester';

export const bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);

// Register Telegram notifiers (Admin + Active Watchers Broadcast)
const sendAdminAlert = async (msg: string, extra?: any) => {
  if (CONFIG.TELEGRAM_ADMIN_ID) {
    try {
      await bot.telegram.sendMessage(CONFIG.TELEGRAM_ADMIN_ID, msg, {
        parse_mode: 'Markdown',
        ...extra
      });
    } catch (err: any) {
      console.error('[Telegram] Gagal kirim pesan ke admin:', err.message);
    }
  }

  // Broadcast to all active Watchers
  try {
    const watchers = getWatchers();
    for (const w of watchers) {
      if (w.user_id !== CONFIG.TELEGRAM_ADMIN_ID) {
        bot.telegram.sendMessage(w.user_id, msg, {
          parse_mode: 'Markdown',
          ...extra
        }).catch((err: any) => {
          if (err?.response?.error_code === 403) {
            removeWatcher(w.user_id);
          }
        });
      }
    }
  } catch {}
};

setTelegramNotifier(sendAdminAlert);
setAlgoScannerNotifier(sendAdminAlert);

// Executive/Admin commands that modify state or settings
const ADMIN_COMMANDS = new Set([
  'buy', 'sell', 'settings', 'resetcb', 'scan'
]);

// Middleware: Role-Based Access Control (Admin vs Watcher)
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  const isAdmin = CONFIG.TELEGRAM_ADMIN_ID && userId === CONFIG.TELEGRAM_ADMIN_ID;

  // If text command
  const text = (ctx.message as any)?.text?.trim();
  if (text && text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]+/)[0].toLowerCase();
    if (ADMIN_COMMANDS.has(cmd) && !isAdmin) {
      return ctx.replyWithMarkdown('⛔ *Akses Ditolak*\nPerintah ini hanya dapat diakses oleh Administrator bot.');
    }
  }

  // If callback query is triggered, check admin-only actions
  const cbData = (ctx.callbackQuery as any)?.data;
  if (cbData) {
    const adminActions = [
      'trigger_buy', 'trigger_sell', 'menu_settings', 'reset_paper_balance'
    ];
    if (adminActions.some(a => cbData.startsWith(a)) && !isAdmin) {
      return ctx.answerCbQuery('⛔ Akses Ditolak: Hanya Administrator', { show_alert: true });
    }
  }

  return next();
});

// 1. COMMAND: /start & /status
bot.command(['start', 'status'], async (ctx) => {
  const userId = ctx.from?.id;
  const isAdmin = CONFIG.TELEGRAM_ADMIN_ID && userId === CONFIG.TELEGRAM_ADMIN_ID;

  // Non-Admin Welcome Screen (Watcher Mode)
  if (!isAdmin) {
    const subscribed = isWatcher(userId || 0);
    const text = `👋 *Halo, ${ctx.from?.first_name || 'Trader'}!*\n\n` +
      `Selamat datang di *Solana Quantitative Algorithmic Trading Bot*!\n` +
      `Kamu saat ini berada dalam mode *Tamu (Watcher / Read-Only)*.\n\n` +
      `Status Notifikasi: ${subscribed ? '🔔 *AKTIF (Menerima Alert Sinyal)*' : '🔕 *NON-AKTIF*'}\n\n` +
      `📋 *Menu yang bisa kamu akses:*\n` +
      `• \`/scan\` - Pindai live pool Solana dengan filter survival phase\n` +
      `• \`/positions\` - Lihat koin yang sedang dipegang bot\n` +
      `• \`/report\` atau \`/pnl\` - Jurnal performa profit 24 jam\n` +
      `• \`/quant\` - Audit metrik kuantitatif (Sharpe, Sortino, Winrate)\n` +
      `• \`/backtest\` - Replay candle historis & uji stres pasar\n` +
      `• \`/watch\` - Langganan notifikasi otomatis\n` +
      `• \`/unwatch\` - Berhenti langganan notifikasi\n\n` +
      `🛡️ *Audit Koin Instan:* Kirimkan Contract Address (CA) token Solana apapun ke sini untuk cek Anti-Rug & Honeypot secara instan!`;

    return ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
      [
        subscribed 
          ? Markup.button.callback('🔕 Berhenti Notifikasi (/unwatch)', 'action_unwatch')
          : Markup.button.callback('🔔 Aktifkan Alert Sinyal (/watch)', 'action_watch')
      ],
      [
        Markup.button.callback('⚡ Pindai Pasar', 'trigger_scan'),
        Markup.button.callback('💼 Posisi Aktif', 'menu_positions')
      ],
      [
        Markup.button.callback('📊 Laporan 24j', 'menu_report'),
        Markup.button.callback('📐 Metrik Quant', 'menu_quant')
      ]
    ]));
  }

  // Admin Master Dashboard
  const balanceSol = getPaperBalance();
  const solPrice = await getSolPriceUsd();
  const stats = getTradingStats();
  const cb = isCircuitBreakerActive();

  const cbStatusText = cb.active
    ? `🛑 *CIRCUIT BREAKER: AKTIF* (Cooldown: ${Math.ceil((cb.untilMs - Date.now()) / 60000)}m)`
    : `🛡️ *Proteksi Pasar:* Normal (0/${CONFIG.CIRCUIT_BREAKER_MAX_DAILY_LOSSES} Max SL)`;

  const text = `🤖 *SOLANA QUANTITATIVE ALGORITHMIC TRADING BOT*\n` +
    `🏛️ *INSTITUTIONAL HEDGE FUND SURVIVAL ENGINE*\n\n` +
    `⚡ *Status Engine:* 🟢 Online (Scanner Siklus 60s Aktif)\n` +
    `🎯 *Strategi:* ⚡ *MURNI ALGORITMA (Hedge Fund Survival Phase)*\n` +
    `🧪 *Mode Eksekusi:* ${CONFIG.PAPER_TRADING ? '*PAPER TRADING (Simulasi $0 Risiko)*' : '*LIVE TRADING (Real SOL)*'}\n` +
    `${cbStatusText}\n\n` +
    `💼 *Saldo Virtual:* *${balanceSol.toFixed(3)} SOL* (~$${(balanceSol * solPrice).toFixed(2)})\n` +
    `📈 *Posisi Terbuka:* *${stats.openPositionsCount}/${CONFIG.MAX_OPEN_POSITIONS}* token\n` +
    `🏆 *Performa Portofolio:* ${stats.winTrades} Win / ${stats.lossTrades} Loss (Winrate: *${stats.winRate}%*)\n` +
    `💵 *Total Realized Net PnL:* *$${stats.totalPnlUsd}*\n\n` +
    `💎 *Pilar Kuantitatif Hedge Fund:*\n` +
    `• *Survival Phase Funnel:* Anti-Detik-0 Suicide (Wajib usia $\\ge$ 3m, curve 25%-85%)\n` +
    `• *Sybil & Anti-Cabal Guard:* Dev holding $\\le$ 5%, minimal 45 unique buyers, LP locked\n` +
    `• *Quantitative Opportunity Scorer:* Algoritma multi-faktor (Bobot Momentum, Breakout & Order Flow)\n` +
    `• *Kelly Sizing:* Fractional Kelly Criterion (${CONFIG.KELLY_FRACTION * 100}% Kelly) & Liquidity Depth Cap\n` +
    `• *Multi-Tier Exits:* Stage 1 TP (+42% kunci 50% modal) + Stage 2 Moonbag Trailing Stop (-18%)\n` +
    `• *Flash-Exit Rug Buster:* Auto-dump jika likuiditas ditarik dev >${CONFIG.FLASH_EXIT_DROP_PCT}%\n` +
    `• *Jito MEV Shield:* ${CONFIG.JITO_MEV_ENABLED ? '✅ Kebal Sandwich Attack (Private Mempool)' : '❌ Nonaktif'}\n\n` +
    `💡 *Tips:* _Ketik /scan untuk memindai pasar live, /positions untuk cek open trade, atau /quant untuk audit Sharpe Ratio!_`;

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('⚡ Pindai Pasar Live (/scan)', 'trigger_scan'),
      Markup.button.callback('💼 Posisi Aktif (/positions)', 'menu_positions')
    ],
    [
      Markup.button.callback('📊 Laporan 24j', 'menu_report'),
      Markup.button.callback('📐 Metrik Quant', 'menu_quant'),
      Markup.button.callback('🔬 Backtester', 'menu_backtest')
    ],
    [
      Markup.button.callback('⚙️ Settings & Risk', 'menu_settings'),
      Markup.button.callback('🔄 Reset Saldo 10 SOL', 'reset_paper_balance')
    ]
  ]));
});

// COMMAND: /help
bot.command('help', async (ctx) => {
  const text = `📖 *DAFTAR LENGKAP PERINTAH TELEGRAM BOT*\n\n` +
    `🤖 *Status & Portofolio:*\n` +
    `• \`/start\` atau \`/status\` - Dashboard utama sistem & status engine quant\n` +
    `• \`/scan\` - Pindai pasar Solana secara live dengan filter Survival Phase\n` +
    `• \`/positions\` - Lihat posisi trade yang sedang aktif dibuka\n` +
    `• \`/report\` atau \`/pnl\` - Jurnal performa trading 24 jam (True Net Accounting)\n` +
    `• \`/quant\` - Audit metrik kuantitatif (Sharpe, Sortino, Profit Factor, MDD)\n` +
    `• \`/backtest\` - Backtester algoritma replay candle historis & skenario stres\n` +
    `• \`/settings\` - Parameter hedge fund, Kelly sizing, slippage & risk controls\n` +
    `• \`/resetcb\` - Reset Circuit Breaker jika terpicu cooldown\n\n` +
    `🛡️ *Audit & Quick Snipe Token:*\n` +
    `• Kirim atau paste Contract Address (CA) Solana apapun untuk audit instan Anti-Rug, Likuiditas, & Quick Buy!`;

  await ctx.replyWithMarkdown(text);
});

// 2. SCAN COMMAND & MARKET SCANNER
export async function handleScanCommand(ctx: any) {
  const isCb = !!ctx.callbackQuery;
  if (isCb) {
    await ctx.answerCbQuery('🔍 Menjalankan Scanner Hedge Fund...');
  }
  await ctx.replyWithMarkdown(
    `🔍 *MEMINDAI PASAR SOLANA (INSTITUTIONAL HEDGE FUND SCANNER)*\n\n` +
    `• Menyaring token survival phase (anti rug, anti cabal, LP locked, curve 25%-85%)...\n` +
    `• Mengkalkulasi skor quant multi-faktor (<1s)...\n` +
    `_Mohon tunggu beberapa detik..._`
  );

  try {
    const candidates = await scanMarketOnce(8);
    if (candidates.length === 0) {
      return ctx.replyWithMarkdown('ℹ️ Belum ditemukan token aktif yang memenuhi kriteria likuiditas dasar. Coba beberapa saat lagi.');
    }

    let text = `⚡ *HASIL SCAN PASAR KUANTITATIF (${candidates.length} Token Dipindai)*\n\n`;

    const buttons: any[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const statusEmoji = c.passed ? '🟢 *LOLOS*' : '🔴 *DITOLAK*';
      const scoreBadge = c.score >= 70 ? '💎 TOP GRADE' : (c.score >= 50 ? '⚖️ NEUTRAL' : '⚠️ LOW CONVICTION');

      text += `*#${i + 1}* ${statusEmoji} *${c.symbol}* (${c.name})\n` +
        `• CA: \`${c.mint}\`\n` +
        `• Skor Quant: *${c.score}/100* [${scoreBadge}]\n` +
        `• Likuiditas: *$${formatNumber(c.liquidityUsd)}* | MC: *$${formatNumber(c.marketCapUsd)}*\n` +
        `• Harga: *${formatPrice(c.priceUsd)}*\n` +
        `• Status Filter: ${c.passed ? '✅ _Memenuhi seluruh standar survival phase_' : `❌ _${c.rejectReason || 'Skor belum mencukupi'}_`}\n\n`;

      if (c.passed || c.score >= 60) {
        buttons.push([
          Markup.button.callback(`⚡ Beli ${c.symbol} (0.05 SOL)`, `buy_quick_${c.mint}_0.05`),
          Markup.button.callback(`⚡ Beli ${c.symbol} (0.1 SOL)`, `buy_quick_${c.mint}_0.1`)
        ]);
      }
    }

    buttons.push([
      Markup.button.callback('🔄 Scan Ulang Pasar', 'trigger_scan'),
      Markup.button.callback('💼 Posisi Aktif', 'menu_positions')
    ]);

    await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
  } catch (err: any) {
    await ctx.replyWithMarkdown(`❌ Terjadi kesalahan saat scanning: ${err.message}`);
  }
}

bot.command('scan', async (ctx) => {
  await handleScanCommand(ctx);
});

bot.hears(/^(scan|pindai)$/i, async (ctx) => {
  await handleScanCommand(ctx);
});

bot.action('trigger_scan', async (ctx) => {
  await handleScanCommand(ctx);
});

// 3. DYNAMIC CONTRACT ADDRESS (CA) LISTENER
bot.hears(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, async (ctx) => {
  const tokenMint = ctx.message.text.trim();
  await handleTokenAuditAndSnipe(ctx, tokenMint);
});

async function handleTokenAuditAndSnipe(ctx: any, tokenMint: string) {
  await ctx.replyWithMarkdown(`🔍 *Menganalisis Token:* \`${tokenMint}\`...`);

  const [market, safety] = await Promise.all([
    getTokenMarketData(tokenMint),
    checkTokenSafety(tokenMint)
  ]);

  if (!market) {
    return ctx.replyWithMarkdown(`❌ Token \`${tokenMint}\` tidak ditemukan atau belum memiliki likuiditas aktif di DEX Solana.`);
  }

  let text = `🪙 *${market.symbol}* - ${market.name}\n` +
    `📝 \`${tokenMint}\`\n\n` +
    `📊 *Data Pasar:*\n` +
    `• Harga: *$${market.priceUsd < 0.01 ? market.priceUsd.toExponential(4) : market.priceUsd.toFixed(6)}*\n` +
    `• Market Cap: *$${formatNumber(market.marketCap)}*\n` +
    `• Likuiditas: *$${formatNumber(market.liquidityUsd)}*\n` +
    `• Perubahan 24 Jam: *${market.priceChange24h >= 0 ? '+' : ''}${market.priceChange24h.toFixed(2)}%*\n\n` +
    `🛡️ *Audit Keamanan Anti-Rug:*\n` +
    `• Score: *${safety.score}/100* (${safety.isSafe ? '✅ AMAN' : '⚠️ RISIKO TINGGI'})\n` +
    `• Mint Authority: ${safety.mintAuthorityRevoked ? '✅ Revoked' : '❌ AKTIF (Bisa cetak koin)'}\n` +
    `• Freeze Authority: ${safety.freezeAuthorityRevoked ? '✅ Revoked' : '❌ AKTIF (Honeypot)'}\n` +
    `• Likuiditas: ${safety.lpBurnedOrLocked ? '✅ Burned / Locked' : '❌ Unlocked (Bisa ditarik dev)'}\n` +
    `• Top 10 Holders: *${safety.top10HoldersPct.toFixed(1)}%*\n`;

  if (safety.risks.length > 0) {
    text += `\n⚠️ *Peringatan:*\n` + safety.risks.map(r => `• ${r}`).join('\n') + `\n`;
  }

  text += `\n_Pilih aksi di bawah ini untuk eksekusi order:_`;

  const buttons = [
    [
      Markup.button.callback('⚡ Beli 0.05 SOL', `buy_quick_${tokenMint}_0.05`),
      Markup.button.callback('⚡ Beli 0.1 SOL', `buy_quick_${tokenMint}_0.1`),
      Markup.button.callback('⚡ Beli 0.25 SOL', `buy_quick_${tokenMint}_0.25`)
    ],
    [
      Markup.button.url('📈 DexScreener', market.url)
    ]
  ];

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
}

// 4. POSITIONS & PORTFOLIO MANAGEMENT
bot.command('positions', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const page = parts.length > 1 ? parseInt(parts[1], 10) || 1 : 1;
  await renderPositions(ctx, page);
});

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  await renderPositions(ctx, 1);
});

bot.action(/positions_page_(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  await renderPositions(ctx, page);
});

bot.action('positions_noop', async (ctx) => {
  await ctx.answerCbQuery();
});

function formatPrice(val: number): string {
  if (!val) return '$0.00';
  if (val < 0.000001) return '$' + val.toExponential(3);
  if (val < 0.01) return '$' + val.toFixed(6);
  if (val < 1) return '$' + val.toFixed(4);
  return '$' + val.toFixed(2);
}

function getDurationText(openedAt: string): string {
  const diffMs = Date.now() - new Date(openedAt).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Baru saja (<1m)';
  if (diffMin < 60) return `${diffMin}m yang lalu`;
  const diffHours = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  return `${diffHours}j ${remMin}m yang lalu`;
}

async function renderPositions(ctx: any, page: number = 1) {
  const positions = getOpenPositions();
  const cashBalanceSol = getPaperBalance();
  const solPrice = await getSolPriceUsd();

  if (positions.length === 0) {
    return ctx.replyWithMarkdown(
      `💼 *POSISI TRADE AKTIF (0/${CONFIG.MAX_OPEN_POSITIONS})*\n\n` +
      `💰 *Kas Tersedia:* *${cashBalanceSol.toFixed(3)} SOL* (~$${(cashBalanceSol * solPrice).toFixed(2)})\n` +
      `📊 *Status:* Tidak ada posisi terbuka saat ini (100% modal aman dalam kas).\n\n` +
      `_Bot akan membuka posisi otomatis saat scanner menemukan token lolos scoring quant $\\ge 70$, atau kamu bisa ketik /scan untuk audit manual._`,
      Markup.inlineKeyboard([
        [Markup.button.callback('⚡ Pindai Pasar Sekarang (/scan)', 'trigger_scan')]
      ])
    );
  }

  let totalInvestedSol = 0;
  let totalCurrentValueUsd = 0;
  let totalUnrealizedPnlUsd = 0;

  for (const p of positions) {
    totalInvestedSol += p.entry_sol;
    totalCurrentValueUsd += (p.amount_tokens * p.current_price_usd);
    totalUnrealizedPnlUsd += (p.pnl_usd || 0);
  }

  const totalCurrentValueSol = solPrice > 0 ? totalCurrentValueUsd / solPrice : totalInvestedSol;
  const totalUnrealizedPnlSol = solPrice > 0 ? totalUnrealizedPnlUsd / solPrice : 0;
  const totalEquitySol = cashBalanceSol + totalCurrentValueSol;
  const totalEquityUsd = totalEquitySol * solPrice;
  const unrealizedPnlPct = totalInvestedSol > 0 ? (totalUnrealizedPnlSol / totalInvestedSol) * 100 : 0;
  const isTotalProfit = totalUnrealizedPnlUsd >= 0;

  const PAGE_SIZE = 4;
  const totalPages = Math.ceil(positions.length / PAGE_SIZE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const displayPositions = positions.slice(startIndex, startIndex + PAGE_SIZE);

  let text = `💼 *RINGKASAN PORTOFOLIO & TRADE AKTIF*\n\n` +
    `💰 *Kas Bebas:* *${cashBalanceSol.toFixed(3)} SOL* (~$${(cashBalanceSol * solPrice).toFixed(2)})\n` +
    `🪙 *Modal Tertanam:* *${totalInvestedSol.toFixed(3)} SOL* (~$${(totalInvestedSol * solPrice).toFixed(2)}) (${positions.length}/${CONFIG.MAX_OPEN_POSITIONS} Posisi)\n` +
    `📊 *Total Ekuitas Portofolio:* *${totalEquitySol.toFixed(3)} SOL* (~$${totalEquityUsd.toFixed(2)})\n` +
    `📈 *Total Floating PnL:* *${isTotalProfit ? '+' : ''}${unrealizedPnlPct.toFixed(2)}%* ${isTotalProfit ? '🟢' : '🔴'} ` +
    `(*${isTotalProfit ? '+' : ''}${totalUnrealizedPnlSol.toFixed(4)} SOL* / *${isTotalProfit ? '+' : ''}$${totalUnrealizedPnlUsd.toFixed(2)}*)\n\n` +
    `───────────────────\n` +
    `📋 *RINCIAN TOKEN AKTIF (Hal ${currentPage}/${totalPages}):*\n\n`;

  for (const p of displayPositions) {
    const isProfit = p.pnl_pct >= 0;
    const tpPct = p.target_tp_pct || CONFIG.TAKE_PROFIT_PCT;
    const slPct = p.target_sl_pct || CONFIG.STOP_LOSS_PCT;

    const tpPrice = p.entry_price_usd * (1 + tpPct / 100);
    const slPrice = p.entry_price_usd * (1 - slPct / 100);
    const distToTp = tpPct - p.pnl_pct;
    const distToSl = p.pnl_pct - (-slPct);

    const estFeeSol = 0.002;
    const estFeeUsd = estFeeSol * solPrice;
    const netPnlUsd = p.pnl_usd - estFeeUsd;
    const netProfit = netPnlUsd >= 0;

    const statusBadge = p.is_half_closed === 1
      ? '🌕 *STAGE 2 MOONBAG* (Modal 50% TP Aman)'
      : '🟢 *POSISI PENUH* (Menuju TP1)';

    text += `🪙 *#${p.id} ${p.token_symbol}* (${p.token_name})\n` +
      `• Status: ${statusBadge}\n` +
      `• Entry: *${formatPrice(p.entry_price_usd)}* | Sekarang: *${formatPrice(p.current_price_usd)}*\n` +
      `• Modal: *${p.entry_sol.toFixed(3)} SOL* (~$${(p.entry_sol * solPrice).toFixed(2)})\n` +
      `• Gross PnL: *${isProfit ? '+' : ''}${p.pnl_pct.toFixed(2)}%* ${isProfit ? '🟢' : '🔴'} (*${p.pnl_usd >= 0 ? '+' : ''}$${p.pnl_usd.toFixed(2)}*)\n` +
      `• 💰 *Net Laba Bersih:* *${netProfit ? '+' : ''}$${netPnlUsd.toFixed(2)}* ${netProfit ? '🟢' : '🔴'}\n` +
      `🎯 *Target TP (+${tpPct.toFixed(0)}%):* *${formatPrice(tpPrice)}* (Jarak: ${distToTp > 0 ? `+${distToTp.toFixed(1)}%` : 'Tercapai! 🚀'})\n` +
      `🛑 *Stop-Loss (-${slPct.toFixed(0)}%):* *${formatPrice(slPrice)}* (Jarak aman: ${distToSl.toFixed(1)}%)\n`;

    if (p.peak_price_usd && p.peak_price_usd > p.entry_price_usd) {
      const trailingTriggerPrice = p.peak_price_usd * (1 - CONFIG.TRAILING_STOP_PCT / 100);
      text += `• Puncak ATH: *${formatPrice(p.peak_price_usd)}* | Trailing Trigger: *${formatPrice(trailingTriggerPrice)}*\n`;
    }

    text += `🏷️ Sinyal: _${p.whale_source || 'Quant Scanner'}_\n` +
      `⏱️ Dibuka: _${getDurationText(p.opened_at)}_\n\n` +
      `───────────────────\n\n`;
  }

  const buttons: any[] = [];

  // Close buttons row
  const closeRow: any[] = [];
  for (const p of displayPositions) {
    closeRow.push(Markup.button.callback(`❌ Jual #${p.id} ${p.token_symbol}`, `sell_100_${p.id}`));
  }
  if (closeRow.length > 0) {
    buttons.push(closeRow);
  }

  if (totalPages > 1) {
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('⬅️ Prev', `positions_page_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`📄 ${currentPage} / ${totalPages}`, 'positions_noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `positions_page_${currentPage + 1}`));
    }
    buttons.push(navRow);
  }

  buttons.push([
    Markup.button.callback('⚡ Pindai Pasar Live', 'trigger_scan'),
    Markup.button.callback('📊 Laporan 24 Jam', 'menu_report')
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
        await ctx.replyWithMarkdown(text, keyboard);
      });
    } else {
      await ctx.replyWithMarkdown(text, keyboard);
    }
  } catch (err: any) {
    await ctx.replyWithMarkdown(text, keyboard);
  }
}

// 5. REPORT & 24H JOURNAL
bot.command(['report', 'pnl'], async (ctx) => {
  await renderReport(ctx);
});

bot.action('menu_report', async (ctx) => {
  await ctx.answerCbQuery();
  await renderReport(ctx);
});

async function renderReport(ctx: any) {
  const daily = getDailyRealizedPnl();
  const solPrice = await getSolPriceUsd();
  const netPnlUsd = daily.netPnlSol * solPrice;
  const isNetProfit = daily.netPnlSol >= 0;

  let text = `📊 *JURNAL PERFORMA & LABA BERSIH 24 JAM (TRUE NET ACCOUNTING)*\n\n` +
    `Standar audit Wall Street yang memperhitungkan biaya riil transaksi (*Gas Drag*, Priority Tips, & Slippage):\n\n` +
    `📈 *Ringkasan Transaksi:*\n` +
    `• Total Trade Selesai: *${daily.totalTrades}* trade\n` +
    `• Win / Loss: *${daily.winTrades}* Menang / *${daily.lossTrades}* Kalah\n` +
    `• Win Rate: *${daily.winRate}%* ${parseFloat(daily.winRate) >= 50 ? '🟢' : '🔴'}\n\n` +
    `💵 *Kalkulasi Laba Bersih:*\n` +
    `• Laba Kotor (Gross PnL): *${daily.grossPnlSol >= 0 ? '+' : ''}${daily.grossPnlSol.toFixed(4)} SOL*\n` +
    `• Biaya Gas & Jito Tip (Est): *-${daily.totalFeesSol.toFixed(4)} SOL*\n` +
    `• 💰 *Laba Bersih Riil (Net PnL):* *${isNetProfit ? '+' : ''}${daily.netPnlSol.toFixed(4)} SOL* (~*${isNetProfit ? '+' : ''}$${netPnlUsd.toFixed(2)}*) ${isNetProfit ? '🟢' : '🔴'}\n\n`;

  if (daily.bestTrade) {
    text += `🏆 *Trade Terbaik:* *+${daily.bestTrade.pnlPct.toFixed(1)}%* (${daily.bestTrade.symbol}) [Net: +${daily.bestTrade.netPnlSol.toFixed(4)} SOL]\n`;
  }
  if (daily.worstTrade) {
    text += `🔻 *Trade Terburuk:* *${daily.worstTrade.pnlPct.toFixed(1)}%* (${daily.worstTrade.symbol}) [Net: ${daily.worstTrade.netPnlSol.toFixed(4)} SOL]\n`;
  }

  const history = getTradeHistory(5);
  if (history.length > 0) {
    text += `\n📜 *5 Transaksi Terakhir:*\n`;
    for (const h of history) {
      const pnlText = h.action === 'SELL'
        ? ` (${h.pnl_pct >= 0 ? '+' : ''}${h.pnl_pct.toFixed(1)}% / ${h.pnl_sol >= 0 ? '+' : ''}${h.pnl_sol.toFixed(4)} SOL)`
        : '';
      const actionBadge = h.action === 'BUY' ? '🟢 BELI' : (h.pnl_pct >= 0 ? '🟢 TP' : '🔴 SL');
      text += `• ${actionBadge} *${h.token_symbol}*: ${h.total_sol.toFixed(3)} SOL${pnlText} _[${h.reason}]_\n`;
    }
  }

  text += `\n_Data diperbarui secara otomatis setiap ada order jual tereksekusi._`;

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('📐 Metrik Quant', 'menu_quant'),
      Markup.button.callback('🔬 Uji Backtest', 'menu_backtest')
    ],
    [
      Markup.button.callback('💼 Posisi Aktif', 'menu_positions'),
      Markup.button.callback('⚡ Pindai Pasar Live', 'trigger_scan')
    ]
  ]));
}

// 6. QUANT METRICS AUDIT
bot.command('quant', async (ctx) => {
  await renderQuantMetrics(ctx);
});

bot.action('menu_quant', async (ctx) => {
  await ctx.answerCbQuery();
  await renderQuantMetrics(ctx);
});

async function renderQuantMetrics(ctx: any) {
  const metrics = getPortfolioQuantMetrics();
  const solPrice = await getSolPriceUsd();
  const netPnlUsd = metrics.netPnlSol * solPrice;

  let text = `📐 *AUDIT STATISTIK & METRIK KUANTITATIF (INSTITUSIONAL)*\n\n` +
    `Standar metrik hedge fund yang mengukur rasio imbal hasil terhadap volatilitas dan risiko kerugian modal:\n\n` +
    `📊 *Rasio Kinerja & Risiko:*\n` +
    `• *Sharpe Ratio:* *${metrics.sharpeRatio}* ${metrics.sharpeRatio >= 1.5 ? '🏆 (Elite Tier)' : (metrics.sharpeRatio >= 1.0 ? '✅ (Baik)' : '⚠️ (Fluktuatif)')}\n` +
    `  _Mengukur excess return terhadap total volatilitas portofolio._\n` +
    `• *Sortino Ratio:* *${metrics.sortinoRatio}* 💎\n` +
    `  _Hanya menghukum volatilitas penurunan (downside risk), ideal untuk koin meme asimetris._\n` +
    `• *Profit Factor:* *${metrics.profitFactor}* ${metrics.profitFactor >= 1.75 ? '🟢 (Prima)' : '🔻'}\n` +
    `  _Rasio total laba kotor dibagi total rugi kotor (standar Wall Street: >1.75)._\n` +
    `• *Max Drawdown (MDD):* *${metrics.maxDrawdownPct}%* (-${metrics.maxDrawdownSol.toFixed(4)} SOL)\n` +
    `  _Penurunan modal terdalam dari titik puncak equity curve._\n` +
    `• *Calmar Ratio:* *${metrics.calmarRatio}*\n` +
    `  _Rasio imbal hasil tahunan terhadap Max Drawdown._\n` +
    `• *Payoff Ratio (Win/Loss):* *${metrics.payoffRatio}x*\n` +
    `  _Rata-rata untung per trade vs rata-rata rugi per trade._\n` +
    `• *Trade Expectancy:* *${metrics.tradeExpectancySol >= 0 ? '+' : ''}${metrics.tradeExpectancySol.toFixed(4)} SOL / trade*\n` +
    `  _Nilai ekspektasi matematis keuntungan setiap kali bot mengeksekusi order._\n\n` +
    `💼 *Ringkasan Akuntansi Real:*\n` +
    `• Total Trade Selesai: *${metrics.totalTrades}* (${metrics.winTrades}W / ${metrics.lossTrades}L - *${metrics.winRatePct}%* Winrate)\n` +
    `• Gross PnL: *${metrics.grossPnlSol >= 0 ? '+' : ''}${metrics.grossPnlSol.toFixed(4)} SOL*\n` +
    `• Gas Drag & Jito Tips: *-${metrics.totalFeesSol.toFixed(4)} SOL*\n` +
    `• 💰 *Net Laba Bersih:* *${metrics.netPnlSol >= 0 ? '+' : ''}${metrics.netPnlSol.toFixed(4)} SOL* (~$${netPnlUsd.toFixed(2)})\n`;

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('🔬 Uji Backtest Historis', 'menu_backtest'),
      Markup.button.callback('📊 Laporan 24 Jam', 'menu_report')
    ]
  ]));
}

// 7. BACKTEST ENGINE
bot.command('backtest', async (ctx) => {
  await handleBacktestCommand(ctx);
});

bot.action('menu_backtest', async (ctx) => {
  await ctx.answerCbQuery();
  await renderBacktestMenu(ctx);
});

async function renderBacktestMenu(ctx: any) {
  const text = `🔬 *INSTITUTIONAL QUANT BACKTEST ENGINE*\n\n` +
    `Uji keandalan strategi kuantitatif (Survival Phase Funnel, Dynamic TP/SL, 2-Stage Moonbag, Flash-Exit Rug Buster, Gas Drag) pada data candle nyata ataupun skenario stres pasar:\n\n` +
    `Pilih salah satu preset skenario atau ketik perintah manual:\n` +
    `• \`/backtest <alamat_token>\` - Uji replay candle on-chain riil (GeckoTerminal)\n` +
    `• \`/backtest <bull|chop|bloodbath|rug>\` - Uji simulasi stres regime pasar`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Popcat (Candle Riil)', 'backtest_popcat'),
      Markup.button.callback('🐂 Skenario Bull Run', 'backtest_regime_bull')
    ],
    [
      Markup.button.callback('🦀 Skenario Choppy Crab', 'backtest_regime_chop'),
      Markup.button.callback('🩸 Skenario Bloodbath Crash', 'backtest_regime_bloodbath')
    ],
    [
      Markup.button.callback('🚀 Skenario Pump & Dump Arc', 'backtest_regime_pumpdump'),
      Markup.button.callback('📐 Metrik Quant Portofolio', 'menu_quant')
    ]
  ]);

  await ctx.replyWithMarkdown(text, keyboard);
}

async function handleBacktestCommand(ctx: any) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length > 1) {
    const target = parts[1].toLowerCase();
    if (['bull', 'chop', 'bloodbath', 'pump_dump', 'rug'].includes(target)) {
      const regime = target === 'rug' ? 'PUMP_DUMP' : target.toUpperCase() as any;
      await runAndSendBacktest(ctx, regime, true);
      return;
    } else {
      await runAndSendBacktest(ctx, parts[1], false);
      return;
    }
  }
  await renderBacktestMenu(ctx);
}

async function runAndSendBacktest(ctx: any, target: string, isSynthetic: boolean) {
  await ctx.replyWithMarkdown(`⏳ *Mengambil data candle & mengeksekusi simulasi algoritma kuantitatif...*`);

  try {
    let report;
    if (isSynthetic) {
      const { candles, tokenSymbol } = generateSyntheticRegime(target as any, 60);
      report = runBacktest(candles, tokenSymbol);
    } else {
      const { candles, tokenSymbol } = await fetchHistoricalCandles(target, 'hour', 60);
      if (candles.length < 5) {
        await ctx.replyWithMarkdown(`❌ Gagal mengambil data candle historis untuk token tersebut. Pastikan token sudah memiliki pool likuiditas aktif di GeckoTerminal/DexScreener.`);
        return;
      }
      report = runBacktest(candles, tokenSymbol);
    }

    const reportText = formatBacktestTelegramReport(report);
    await ctx.replyWithMarkdown(reportText, Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Uji Skenario Lain', 'menu_backtest'),
        Markup.button.callback('📐 Metrik Quant', 'menu_quant')
      ]
    ]));
  } catch (err: any) {
    await ctx.replyWithMarkdown(`❌ Terjadi error saat backtesting: ${err.message}`);
  }
}

// Backtest Preset Callbacks
bot.action('backtest_popcat', async (ctx) => {
  await ctx.answerCbQuery('Memulai backtest Popcat...');
  await runAndSendBacktest(ctx, '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', false);
});

bot.action('backtest_regime_bull', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Bull Run...');
  await runAndSendBacktest(ctx, 'BULL', true);
});

bot.action('backtest_regime_chop', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Choppy...');
  await runAndSendBacktest(ctx, 'CHOP', true);
});

bot.action('backtest_regime_bloodbath', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Bloodbath...');
  await runAndSendBacktest(ctx, 'BLOODBATH', true);
});

bot.action('backtest_regime_pumpdump', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Pump & Dump...');
  await runAndSendBacktest(ctx, 'PUMP_DUMP', true);
});

// 8. SETTINGS & RISK CONTROLS
bot.command('settings', async (ctx) => {
  await renderSettings(ctx);
});

bot.action('menu_settings', async (ctx) => {
  await ctx.answerCbQuery();
  await renderSettings(ctx);
});

async function renderSettings(ctx: any) {
  const balance = getPaperBalance();
  const cb = isCircuitBreakerActive();
  const solPrice = await getSolPriceUsd();

  const text = `⚙️ *PARAMETER HEDGE FUND & KONTROL RISIKO*\n\n` +
    `🔬 *Algoritma & Eksekusi:*\n` +
    `• Mode: *MURNI ALGORITMA (HEDGE FUND QUANT)*\n` +
    `• Alokasi Modal: *Fractional Kelly (${CONFIG.KELLY_FRACTION * 100}%)*\n` +
    `• Nominal Default Buy: *${CONFIG.DEFAULT_BUY_AMOUNT_SOL} SOL*\n` +
    `• Max Open Positions: *${CONFIG.MAX_OPEN_POSITIONS} token*\n` +
    `• Slippage Toleransi: *${CONFIG.SLIPPAGE_PCT}%*\n\n` +
    `🎯 *Exit & Proteksi Profit:*\n` +
    `• Stage 1 Take-Profit: *+${CONFIG.TAKE_PROFIT_PCT}%* (Jual 50% & Kunci Modal)\n` +
    `• Stage 2 Moonbag Trailing Stop: *-${CONFIG.TRAILING_STOP_PCT}%* dari ATH\n` +
    `• Hard Stop-Loss: *-${CONFIG.STOP_LOSS_PCT}%*\n` +
    `• Flash-Exit Rug Buster: Dump jika likuiditas hilang *>${CONFIG.FLASH_EXIT_DROP_PCT}%*\n\n` +
    `🛡️ *Survival Phase Funnel:*\n` +
    `• Anti-Detik-0 Usia Minimum: *${CONFIG.MIN_TOKEN_AGE_SEC} detik (3 menit)*\n` +
    `• Bonding Curve Sweet Spot: *${CONFIG.BONDING_CURVE_MIN_PCT}% - ${CONFIG.BONDING_CURVE_MAX_PCT}%*\n` +
    `• Maksimal Dev Holding: *${CONFIG.MAX_DEV_HOLDING_PCT}%*\n` +
    `• Minimal Unique Buyers: *${CONFIG.MIN_UNIQUE_HOLDERS} wallets*\n` +
    `• Minimal Likuiditas: *$${formatNumber(CONFIG.MIN_LIQUIDITY_USD)}*\n\n` +
    `🛑 *Circuit Breaker:* ${cb.active ? `AKTIF (Cooldown)` : 'Normal (Siap Order)'}\n` +
    `💼 *Kas Tersedia:* *${balance.toFixed(3)} SOL* (~$${(balance * solPrice).toFixed(2)})\n`;

  const buttons: any[] = [
    [
      Markup.button.callback('⚡ Pindai Pasar Live', 'trigger_scan'),
      Markup.button.callback('💼 Posisi Aktif', 'menu_positions')
    ]
  ];

  if (cb.active) {
    buttons.push([Markup.button.callback('🔓 Reset Circuit Breaker Manual', 'reset_circuit_breaker')]);
  }

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
}

// Reset Circuit Breaker
bot.command('resetcb', async (ctx) => {
  resetCircuitBreaker();
  await ctx.replyWithMarkdown('✅ *Circuit Breaker berhasil direset!* Bot sekarang siap membuka order kembali.');
});

bot.action('reset_circuit_breaker', async (ctx) => {
  await ctx.answerCbQuery('Circuit Breaker direset!');
  resetCircuitBreaker();
  await ctx.replyWithMarkdown('✅ *Circuit Breaker berhasil direset!* Bot sekarang siap membuka order kembali.');
});

// Reset Dummy Balance
bot.action('reset_paper_balance', async (ctx) => {
  await ctx.answerCbQuery('Saldo direset!');
  resetPaperBalance(CONFIG.INITIAL_PAPER_BALANCE_SOL);
  await ctx.replyWithMarkdown(`🔄 Saldo virtual berhasil direset ke *${CONFIG.INITIAL_PAPER_BALANCE_SOL} SOL*!`);
});

// Inline Sell Action
bot.action(/sell_100_(\d+)/, async (ctx) => {
  const posId = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery('Mengeksekusi penjualan...');
  const result = await executeSellToken(posId, 100, 'MANUAL_INLINE_BUTTON');
  if (!result.success) {
    await ctx.replyWithMarkdown(`❌ Gagal: ${result.message}`);
  }
});

// Inline Quick Buy Action
bot.action(/buy_quick_([1-9A-HJ-NP-Za-km-z]{32,44})_([\d.]+)/, async (ctx) => {
  const tokenMint = ctx.match[1];
  const amountSol = parseFloat(ctx.match[2]);

  await ctx.answerCbQuery(`Mengeksekusi order ${amountSol} SOL...`);
  await ctx.replyWithMarkdown(`⚡ Memproses pembelian *${amountSol} SOL* untuk \`${tokenMint}\`...`);

  const result = await executeBuyToken(tokenMint, amountSol, 'MANUAL_SNIPER');
  if (!result.success) {
    await ctx.replyWithMarkdown(`❌ Pembelian gagal: ${result.message}`);
  }
});

// Watcher Actions
bot.command('watch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  addWatcher(userId, ctx.from?.username, ctx.from?.first_name);
  await ctx.replyWithMarkdown(`🔔 *Alert Sinyal Aktif!* Kamu akan menerima notifikasi otomatis setiap bot membuka posisi trade.`);
});

bot.command('unwatch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  removeWatcher(userId);
  await ctx.replyWithMarkdown(`🔕 *Notifikasi Dinonaktifkan.* Ketik \`/watch\` jika ingin mengaktifkannya kembali.`);
});

bot.action('action_watch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  addWatcher(userId, ctx.from?.username, ctx.from?.first_name);
  await ctx.answerCbQuery('🔔 Mode Watcher Aktif!');
  await ctx.replyWithMarkdown(`🔔 *Alert Sinyal Aktif!* Kamu akan menerima notifikasi otomatis setiap bot membuka posisi trade.`);
});

bot.action('action_unwatch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  removeWatcher(userId);
  await ctx.answerCbQuery('🔕 Notifikasi Dimatikan');
  await ctx.replyWithMarkdown(`🔕 *Notifikasi Dimatikan.* Ketik \`/watch\` untuk menyalakan kembali.`);
});

function formatNumber(num: number): string {
  if (!num) return '0';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K';
  return num.toFixed(2);
}
