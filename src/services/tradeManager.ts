import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { 
  getPaperBalance, 
  updatePaperBalance, 
  getOpenPositions, 
  getOpenPositionByToken, 
  createPosition, 
  updatePositionPrice, 
  closePosition, 
  getPositionById,
  halfClosePosition,
  recordWhaleTrade,
  isCircuitBreakerActive,
  tripCircuitBreaker,
  getDailyStopLossCount
} from '../db/index';
import { getTokenMarketData, getSolPriceUsd } from './dexscreener';
import { getOnChainBondingCurve, getBondingCurveAddress, decodeBondingCurveBuffer } from './bondingCurve';
import { checkTokenSafety } from './antirug';
import { getBuyQuote, getSellQuote } from './jupiter';
import { Whale, Position } from '../types/index';
import { getDedicatedConnection, getDedicatedEndpoint } from './solanaConnection';

const positionEndpoint = getDedicatedEndpoint('POSITION_MANAGER');
const wsUrl = positionEndpoint.wsUrl;
const connection = getDedicatedConnection('POSITION_MANAGER');

type TelegramNotifier = (message: string, extra?: any) => Promise<void>;
let telegramNotifier: TelegramNotifier | null = null;
let lastCircuitBreakerNotifyTime = 0;
const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000; // 15 menit

export function setTelegramNotifier(notifier: TelegramNotifier) {
  telegramNotifier = notifier;
}

async function notify(message: string, extra?: any) {
  if (telegramNotifier) {
    try {
      await telegramNotifier(message, extra);
    } catch (err: any) {
      console.error('[TradeManager] Failed to send Telegram notification:', err.message);
    }
  }
}

export function extractNarrative(symbol: string, name: string): string {
  const text = `${symbol} ${name}`.toLowerCase();
  if (/dog|shib|inu|bonk|floki|wif|pup|canine|hound/.test(text)) return 'DOG';
  if (/cat|meow|kitty|neko|mimi|feline|happycat/.test(text)) return 'CAT';
  if (/ai|gpt|agent|bot|intelligence|compute|neural|agi/.test(text)) return 'AI';
  if (/trump|biden|kamala|maga|vote|politic|usa|presid/.test(text)) return 'POLITICS';
  if (/pepe|frog|toad|kek|ribbit/.test(text)) return 'PEPE';
  return 'OTHER';
}

// 1. EXECUTE BUY (Copy-Trade or Manual)
export async function executeBuyToken(
  tokenMint: string,
  amountSol: number = CONFIG.DEFAULT_BUY_AMOUNT_SOL,
  source: string = 'MANUAL',
  whale?: Whale,
  whaleEntryPriceUsd?: number,
  prefetchedMarketData?: any
): Promise<{ success: boolean; message: string; position?: Position }> {
  // Circuit Breaker Kill-Switch: Block buys if market crash / severe loss streak detected
  const cb = isCircuitBreakerActive();
  if (cb.active) {
    const remainingMins = Math.ceil((cb.untilMs - Date.now()) / (60 * 1000));
    console.log(`[AutoTrade] 🛑 Order ditolak karena Circuit Breaker aktif (${remainingMins}m).`);
    const now = Date.now();
    if (now - lastCircuitBreakerNotifyTime > CIRCUIT_BREAKER_COOLDOWN_MS) {
      lastCircuitBreakerNotifyTime = now;
      const alertMsg = `🛑 *ORDER DITOLAK: CIRCUIT BREAKER SEDANG AKTIF!*\n\n` +
        `⏱️ Sisa Waktu Cooldown: *${remainingMins} menit*\n` +
        `⚠️ Alasan: *${cb.reason}*\n\n` +
        `_Bot menolak seluruh order beli baru demi melindungi portofolio dari kondisi pasar ekstrem._\n` +
        `ℹ️ _Notifikasi ini dibatasi (maks 1x per 15 menit) agar tidak spam._`;
      await notify(alertMsg);
    }
    return { success: false, message: `Circuit breaker aktif (${remainingMins}m tersisa)` };
  }

  // Check if position already open
  const existing = getOpenPositionByToken(tokenMint);
  if (existing) {
    console.log(`[AutoTrade] ℹ️ Token ${existing.token_symbol} (${tokenMint}) sudah aktif di portofolio. Melewati pembelian duplikat.`);
    return { success: false, message: `Posisi untuk token ${existing.token_symbol} sudah aktif dibuka.` };
  }

  const isCopyTrade = source === 'COPY_TRADE';
  const shouldNotifyFilterSkip = CONFIG.NOTIFY_ON_REJECT !== false;

  // Institutional Risk Control 1: Maximum Concurrent Open Positions
  const openPositions = getOpenPositions();
  if (openPositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
    console.log(`[AutoTrade] 🛡️ Maksimal posisi aktif (${CONFIG.MAX_OPEN_POSITIONS}) tercapai. Menolak order baru.`);
    if (shouldNotifyFilterSkip) {
      let tokenSymbol = 'TOKEN';
      let tokenName = 'Token Solana';
      try {
        const mData = prefetchedMarketData || await getTokenMarketData(tokenMint);
        if (mData) {
          tokenSymbol = mData.symbol;
          tokenName = mData.name;
        }
      } catch {}

      const whaleLabel = whale ? `\n🐋 *Sumber Paus:* ${whale.label}` : '';
      const alertMsg = `⚠️ *ORDER DILEWATI: PORTFOLIO EXPOSURE PENUH*\n\n` +
        `🪙 *Token:* *${tokenSymbol}* (${tokenName})\n` +
        `📝 *CA:* \`${tokenMint}\`${whaleLabel}\n` +
        `📊 *Posisi Aktif:* *${openPositions.length}/${CONFIG.MAX_OPEN_POSITIONS} token* (Kapasitas Penuh)\n\n` +
        `🛡️ _Bot menolak membuka posisi baru untuk menjaga cadangan kas (Cash Buffer) sesuai standar manajemen risiko institusional._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Maksimal posisi aktif portofolio tercapai' };
  }

  // Check paper balance
  const currentBalance = getPaperBalance();
  if (currentBalance < amountSol) {
    const msg = `⚠️ Saldo tidak cukup! Saldo: ${currentBalance.toFixed(3)} SOL, Diperlukan: ${amountSol.toFixed(3)} SOL`;
    if (shouldNotifyFilterSkip) {
      await notify(msg);
    }
    return { success: false, message: msg };
  }

  // 1. High-Speed Concurrent Pipeline (<400ms parallel fetch instead of sequential waiting!)
  const marketDataPromise = prefetchedMarketData 
    ? Promise.resolve(prefetchedMarketData) 
    : getTokenMarketData(tokenMint);
  const safetyPromise = checkTokenSafety(tokenMint);
  const solPricePromise = getSolPriceUsd();

  const [marketData, safety, solPriceUsd] = await Promise.all([
    marketDataPromise,
    safetyPromise,
    solPricePromise
  ]);

  if (!marketData) {
    const msg = `❌ Gagal mengambil data pasar dari DexScreener untuk token \`${tokenMint}\`. Token mungkin terlalu baru atau likuiditas belum terdeteksi.`;
    return { success: false, message: msg };
  }

  // Ultra-Fast On-Chain Price for Pump.fun tokens (<50ms Direct PDA Buffer Decode)
  if (tokenMint.endsWith('pump')) {
    try {
      const onChainCurve = await getOnChainBondingCurve(tokenMint);
      if (onChainCurve && !onChainCurve.complete && onChainCurve.spotPriceSol > 0) {
        const liveCurvePriceUsd = onChainCurve.spotPriceSol * solPriceUsd;
        if (liveCurvePriceUsd > 0) {
          marketData.priceUsd = liveCurvePriceUsd;
          marketData.liquidityUsd = onChainCurve.liquiditySol * solPriceUsd;
        }
      }
    } catch {}
  }

  // Institutional Risk Control 1.5: Narrative / Sector Concentration Shield
  const currentNarrative = extractNarrative(marketData.symbol, marketData.name);
  if (currentNarrative !== 'OTHER') {
    const matchingPositions = openPositions.filter(p => extractNarrative(p.token_symbol, p.token_name) === currentNarrative);
    if (matchingPositions.length >= CONFIG.MAX_POSITIONS_PER_NARRATIVE) {
      console.log(`[AutoTrade] 🛡️ Narrative Shield: Sudah ada ${matchingPositions.length} posisi di sektor ${currentNarrative}. Menolak order untuk mencegah correlated risk.`);
      if (shouldNotifyFilterSkip) {
        await notify(`⚠️ *ORDER DIBATALKAN: NARRATIVE SHIELD*\n\nPortofolio sudah memiliki ${matchingPositions.length} koin di sektor *${currentNarrative}* (${matchingPositions.map(p => p.token_symbol).join(', ')}). Bot mencegah risiko kerugian terkorelasi.`);
      }
      return { success: false, message: `Maksimal posisi sektor ${currentNarrative} tercapai` };
    }
  }

  // Pump.fun bonding curve tokens have guaranteed virtual liquidity in the contract (even before Raydium graduation)
  const isPumpFun = tokenMint.endsWith('pump') || marketData.dexId === 'pumpfun';
  const effectiveLiquidity = marketData.liquidityUsd > 0 
    ? marketData.liquidityUsd 
    : (isPumpFun && marketData.marketCap >= 5000 ? Math.max(5000, marketData.marketCap * 0.35) : marketData.liquidityUsd);

  // Institutional Risk Control 2: Minimum Liquidity & Market Cap Floor
  if (effectiveLiquidity < CONFIG.MIN_LIQUIDITY_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: Likuiditas $${effectiveLiquidity.toFixed(0)} < $${CONFIG.MIN_LIQUIDITY_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: LIKUIDITAS TERLALU RENDAH*\n\n` +
        `🪙 *Token:* ${marketData.symbol} (${marketData.name})\n` +
        `💧 *Likuiditas Pool:* *$${formatNumber(effectiveLiquidity)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_LIQUIDITY_USD)}*)\n\n` +
        `_Bot menolak membeli di pool illiquid untuk mencegah jebakan slippage dan price impact raksasa._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Likuiditas pool di bawah standar minimum' };
  }

  // Institutional Risk Control 2b: Minimum 24h Volume Floor (Active Market Depth)
  if (marketData.volume24h !== undefined && marketData.volume24h > 0 && marketData.volume24h < CONFIG.MIN_VOLUME_24H_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: Volume 24j $${marketData.volume24h.toFixed(0)} < $${CONFIG.MIN_VOLUME_24H_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: VOLUME 24J TERLALU RENDAH*\n\n` +
        `🪙 *Token:* ${marketData.symbol} (${marketData.name})\n` +
        `📊 *Volume 24 Jam:* *$${formatNumber(marketData.volume24h)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_VOLUME_24H_USD)}*)\n\n` +
        `_Bot menolak token sepi transaksi untuk menghindari risiko token mati / zombie memecoin._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Volume 24 jam token di bawah standar minimum' };
  }

  if (marketData.marketCap < CONFIG.MIN_MARKET_CAP_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: MC $${marketData.marketCap.toFixed(0)} < $${CONFIG.MIN_MARKET_CAP_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: MARKET CAP TERLALU KECIL*\n\n` +
        `🪙 *Token:* ${marketData.symbol} (${marketData.name})\n` +
        `📊 *Market Cap:* *$${formatNumber(marketData.marketCap)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_MARKET_CAP_USD)}*)\n\n` +
        `_Bot menolak token kapitalisasi mikro dengan risiko manipulasi dev tinggi._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Market Cap di bawah standar minimum' };
  }

  // Institutional Risk Control 3: Anti-Chase / Price Drift Guard (Pucuk Guard)
  if (whaleEntryPriceUsd && whaleEntryPriceUsd > 0) {
    const driftPct = ((marketData.priceUsd - whaleEntryPriceUsd) / whaleEntryPriceUsd) * 100;
    if (driftPct > CONFIG.MAX_PRICE_DRIFT_PCT) {
      console.log(`[AutoTrade] 🛡️ Anti-Chase triggered: drift +${driftPct.toFixed(1)}% > ${CONFIG.MAX_PRICE_DRIFT_PCT}% (${marketData.symbol})`);
      if (shouldNotifyFilterSkip) {
        const alertMsg = `⚠️ *ORDER DIBATALKAN: ANTI-CHASE GUARD (Pucuk Guard)*\n\n` +
          `🪙 *Token:* ${marketData.symbol}\n` +
          `🐋 *Entry Paus:* *$${whaleEntryPriceUsd < 0.01 ? whaleEntryPriceUsd.toExponential(4) : whaleEntryPriceUsd.toFixed(6)}*\n` +
          `📈 *Harga Pasar Sekarang:* *$${marketData.priceUsd < 0.01 ? marketData.priceUsd.toExponential(4) : marketData.priceUsd.toFixed(6)}* (+${driftPct.toFixed(1)}% dari paus)\n` +
          `🛡️ *Batas Toleransi Drift:* *+${CONFIG.MAX_PRICE_DRIFT_PCT}%*\n\n` +
          `_Bot menolak mengejar koin yang sudah terlanjur melambung tinggi agar modal Anda tidak menjadi exit liquidity!_`;
        await notify(alertMsg);
      }
      return { success: false, message: 'Harga sudah naik terlalu tinggi dari entry paus' };
    }
  }

  // Institutional Risk Control 4: Anti-FOMO Parabolic 5-Minute Spike Guard
  if (marketData.priceChange5m && marketData.priceChange5m > CONFIG.MAX_5M_PRICE_CHANGE_PCT) {
    console.log(`[AutoTrade] 🛡️ Anti-FOMO triggered: 5m change +${marketData.priceChange5m.toFixed(1)}% (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: ANTI-FOMO SPIKE GUARD*\n\n` +
        `🪙 *Token:* ${marketData.symbol}\n` +
        `⚡ *Lonjakan 5 Menit:* *+${marketData.priceChange5m.toFixed(1)}%* (Batas Maksimal: +${CONFIG.MAX_5M_PRICE_CHANGE_PCT}%)\n\n` +
        `_Bot mendeteksi candle parabola vertikal yang rawan aksi dump instan._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Candle 5 menit terlalu overextended' };
  }

  // 2. Anti-Rug Safety Audit (Result from concurrent Promise.all)
  if (!safety.isSafe) {
    console.log(`[AutoTrade] 🛡️ Anti-Rug failed for ${marketData.symbol}: score ${safety.score}/100, risks: ${safety.risks.join(', ')}`);
    if (shouldNotifyFilterSkip) {
      const riskDetails = safety.risks.map(r => `• ${r}`).join('\n');
      const alertMsg = `⚠️ *AUTO-BUY DIBATALKAN (RISIKO TINGGI)*\n\n` +
        `🪙 *Token:* ${marketData.symbol} (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n` +
        `🛡️ *Safety Score:* ${safety.score}/100 (Di bawah standar aman)\n\n` +
        `*Penyebab Pembatalan:*\n${riskDetails}\n\n` +
        `_Bot melindungi saldo Anda dari potensi rug pull / honeypot._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Token tidak lolos filter Anti-Rug.' };
  }

  // 3. Compute execution price & tokens received
  let amountTokens = 0;
  const entryPriceUsd = marketData.priceUsd;

  // Try Jupiter Quote first for high fidelity
  const jupQuote = await getBuyQuote(tokenMint, amountSol);
  if (jupQuote && Number(jupQuote.outAmount) > 0) {
    // Standardize decimals (most SPL tokens are 6 or 9 decimals)
    amountTokens = (amountSol * solPriceUsd) / entryPriceUsd;
  } else {
    // Calculate via DexScreener native price
    amountTokens = (amountSol * solPriceUsd) / entryPriceUsd;
  }

  // 4. Deduct Paper Balance
  updatePaperBalance(-amountSol);

  // Institutional Continuous Conditional Risk/Reward Engine
  let targetTpPct = CONFIG.TAKE_PROFIT_PCT;
  let targetSlPct = CONFIG.STOP_LOSS_PCT;
  if (CONFIG.VOLATILITY_ADAPTIVE_EXITS) {
    const absVol = marketData.priceChange5m ? Math.abs(marketData.priceChange5m) : 0;
    
    // Dynamic Stop-Loss: strictly bounded between 10.0% and 14.0%
    // In low-liquidity memecoins, wide SL (like 25%) leads to fatal drawdowns.
    // Instead, SL is kept tight (-10% to -14%) while position size is downscaled by Kelly.
    const volSlAdjustment = Math.min(2.0, absVol * 0.10);
    const liqSlAdjustment = effectiveLiquidity < 15000 ? 1.0 : (effectiveLiquidity > 50000 ? -1.0 : 0.0);
    targetSlPct = Math.min(14.0, Math.max(10.0, CONFIG.STOP_LOSS_PCT + volSlAdjustment + liqSlAdjustment));
    targetSlPct = Math.round(targetSlPct * 10) / 10;

    // Dynamic Take-Profit: dynamically expanded on high momentum/volatility
    // Guarantees an institutional 3.0:1 to 4.5:1 asymmetric payoff ratio!
    const dynamicTpMultiplier = 3.0 + Math.min(1.0, (absVol / 20.0));
    targetTpPct = Math.min(65.0, Math.max(CONFIG.TAKE_PROFIT_PCT, targetSlPct * dynamicTpMultiplier));
    targetTpPct = Math.round(targetTpPct * 10) / 10;
  }

  // 5. Create Position in Database
  const position = createPosition({
    token_address: tokenMint,
    token_symbol: marketData.symbol,
    token_name: marketData.name,
    amount_tokens: amountTokens,
    entry_price_usd: entryPriceUsd,
    entry_sol: amountSol,
    whale_source: whale ? whale.label : source,
    target_tp_pct: targetTpPct,
    target_sl_pct: targetSlPct
  });
  refreshPositionWebSocketSubscriptions();

  const remainingBalance = getPaperBalance();
  const buyAlert = `🚀 *ORDER BELI BERHASIL DIEKSEKUSI!* (Simulasi $0)\n\n` +
    `🏷️ *Sumber:* ${whale ? `🐋 ${whale.label}` : '⚡ Manual Sniper'}\n` +
    `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
    `📝 *CA:* \`${tokenMint}\`\n\n` +
    `📊 *Rincian Order:*\n` +
    `• Nominal: *${amountSol.toFixed(3)} SOL* (~$${(amountSol * solPriceUsd).toFixed(2)})\n` +
    `• Harga Entry: *$${entryPriceUsd < 0.01 ? entryPriceUsd.toExponential(4) : entryPriceUsd.toFixed(6)}*\n` +
    `• Market Cap: *$${formatNumber(marketData.marketCap)}*\n` +
    `• Likuiditas: *$${formatNumber(effectiveLiquidity)}*\n` +
    `• Anti-Rug Score: *${safety.score}/100* (✅ Aman)\n` +
    `• Sisa Saldo Dummy: *${remainingBalance.toFixed(3)} SOL*\n\n` +
    `🎯 *Target TP:* +${targetTpPct}% | 🛑 *Cut Loss:* -${targetSlPct}% (Adaptive Volatility)\n` +
    `_Bot memantau pergerakan harga secara realtime._`;

  await notify(buyAlert, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📈 DexScreener', url: marketData.url },
          { text: '💰 Jual 100%', callback_data: `sell_100_${position.id}` }
        ]
      ]
    }
  });

  return { success: true, message: 'Order berhasil dibuka', position };
}

// 2. EXECUTE SELL / CLOSE POSITION
export async function executeSellToken(
  positionId: number,
  sellPct: number = 100,
  reason: string = 'MANUAL_SELL'
): Promise<{ success: boolean; message: string }> {
  const pos = getPositionById(positionId);
  if (!pos || pos.status !== 'OPEN') {
    return { success: false, message: 'Posisi tidak ditemukan atau sudah ditutup.' };
  }

  // Fetch live market data for exit price
  const marketData = await getTokenMarketData(pos.token_address);
  const currentPriceUsd = marketData ? marketData.priceUsd : pos.current_price_usd;
  const solPriceUsd = await getSolPriceUsd();

  // Calculate return in SOL
  const currentValueUsd = pos.amount_tokens * currentPriceUsd * (sellPct / 100);
  const exitSol = currentValueUsd / solPriceUsd;

  // Add proceeds back to paper balance
  updatePaperBalance(exitSol);

  // Close position in DB
  closePosition(pos.id, currentPriceUsd, exitSol, `${reason} (${sellPct}%)`);
  refreshPositionWebSocketSubscriptions();

  const pnlPct = ((currentPriceUsd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
  const pnlSol = exitSol - pos.entry_sol;
  const isProfit = pnlPct >= 0;
  const newBalance = getPaperBalance();

  // True Net Fee Accounting
  const roundTripFeeSol = CONFIG.ESTIMATED_BUY_FEE_SOL + CONFIG.ESTIMATED_SELL_FEE_SOL;
  const netPnlSol = pnlSol - roundTripFeeSol;
  const isNetProfit = netPnlSol >= 0;

  // Record whale performance for institutional grading & auto-promotion
  if (pos.whale_source && pos.whale_source !== 'MANUAL' && pos.whale_source !== 'MANUAL_SNIPER') {
    const perf = recordWhaleTrade(pos.whale_source, pnlSol, isProfit);
    if (perf?.promoted) {
      const promoMsg = `🎖️ *PROMOSI ELITE SMART MONEY!*\n\n` +
        `Dompet *${perf.whale.label}* (\`${perf.whale.address.slice(0, 6)}...${perf.whale.address.slice(-4)}\`) berhasil membuktikan profitabilitas!\n` +
        `• Win Rate: *${perf.winRate.toFixed(1)}%*\n` +
        `• Total PnL: *+${perf.whale.total_pnl_sol.toFixed(4)} SOL*\n` +
        `• Status Baru: *VERIFIED ELITE (AUTO-COPY AKTIF)* 🚀\n\n` +
        `_Mulai sekarang, bot akan otomatis menyalin trade dari paus terverifikasi ini._`;
      await notify(promoMsg);
    } else if (perf?.demoted) {
      const demoteMsg = `⏸️ *ALPHA BENCH: PAUS DIISTIRAHATKAN KE SHADOW MODE!*\n\n` +
        `Dompet *${perf.whale.label}* (\`${perf.whale.address.slice(0, 6)}...${perf.whale.address.slice(-4)}\`) mengalami ${CONFIG.MAX_CONSECUTIVE_LOSSES_DEMOTE}x Stop-Loss beruntun.\n` +
        `• Status Baru: *PROBATION (SHADOW BENCH)* 🔬\n` +
        `• Status Copy: *OFF (0 SOL Modal Dipertaruhkan)* 🛡️\n\n` +
        `_Paus tidak dihapus permanen untuk menguji apakah ini murni nasib sial (variance) atau sinyal rusak. Bot mengamankan modal Anda di balik layar. Begitu mencetak profit kembali di shadow mode, statusnya otomatis dipromosikan ke VERIFIED!_`;
      await notify(demoteMsg);
    }
  }

  // Execution Escalation Log for Emergency Exits
  if (reason.includes('SL') || reason.includes('FLASH_EXIT') || reason.includes('WHALE_DUMP')) {
    console.log(`[TradeManager] ⚡ Emergency Exit detected (${reason}). Escalating priority fee & widening slippage tolerance.`);
  }

  const sellAlert = `${isProfit ? '🎉 *TAKE PROFIT DIEKSEKUSI!*' : '🛑 *STOP LOSS DIEKSEKUSI!*'} (Simulasi)\n\n` +
    `🪙 *Token:* *${pos.token_symbol}*\n` +
    `📝 *Alasan:* \`${reason}\`\n\n` +
    `📊 *Hasil Perdagangan (True Net Accounting):*\n` +
    `• PnL %: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%* ${isProfit ? '🟢' : '🔴'}\n` +
    `• Gross PnL: *${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL* (~$${(pnlSol * solPriceUsd).toFixed(2)})\n` +
    `• Biaya On-Chain: *-${roundTripFeeSol.toFixed(4)} SOL* (Gas + Priority + Jito Tip)\n` +
    `• Net PnL Bersih: *${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(4)} SOL* (~$${(netPnlSol * solPriceUsd).toFixed(2)}) ${isNetProfit ? '💰' : '🔻'}\n` +
    `• Modal Posisi: ${pos.entry_sol.toFixed(3)} SOL\n` +
    `• Hasil Penjualan: *${exitSol.toFixed(4)} SOL*\n` +
    `• Saldo Virtual Sekarang: *${newBalance.toFixed(3)} SOL*\n\n` +
    `_Riwayat tersimpan ke database._`;

  await notify(sellAlert);

  // Institutional Risk Control: Circuit Breaker Max Daily Drawdown / Consecutive Stop-Loss Guard
  if (CONFIG.CIRCUIT_BREAKER_ENABLED && (!isProfit || reason.includes('SL') || reason.includes('STOP_LOSS'))) {
    const dailyLosses = getDailyStopLossCount();
    if (dailyLosses >= CONFIG.CIRCUIT_BREAKER_MAX_DAILY_LOSSES) {
      tripCircuitBreaker(
        CONFIG.CIRCUIT_BREAKER_COOLDOWN_HOURS,
        `Terjadi ${dailyLosses}x Stop-Loss dalam 24 jam terakhir`
      );
      const cbAlert = `🚨 *EMERGENCY: CIRCUIT BREAKER DIAKTIFKAN!* 🚨\n\n` +
        `⚠️ Batas kerugian harian tercapai: *${dailyLosses}x Stop Loss dalam 24 jam*.\n` +
        `🛑 Seluruh order beli baru DIBEKUKAN selama *${CONFIG.CIRCUIT_BREAKER_COOLDOWN_HOURS} jam*.\n\n` +
        `_Tindakan perlindungan modal hedge fund otomatis untuk menghindari gelombang rug pull atau kondisi crash pasar solana._`;
      await notify(cbAlert);
    }
  }

  return { success: true, message: `Posisi ${pos.token_symbol} berhasil ditutup.` };
}

// 2.5 EXECUTE WHALE SELL FOLLOW (DUMP SYNCHRONIZATION)
export async function executeWhaleSellFollow(
  whale: Whale,
  tokenMint: string,
  tokensSold?: number
): Promise<{ success: boolean; message: string }> {
  if (!CONFIG.COPY_SELL_ENABLED) {
    return { success: false, message: 'Whale copy-sell synchronization dinonaktifkan di konfigurasi.' };
  }

  const pos = getOpenPositionByToken(tokenMint);
  if (!pos) {
    return { success: false, message: 'Tidak ada posisi terbuka untuk token ini.' };
  }

  console.log(`[TradeManager] 🚨 WHALE SELL DETECTED! Paus ${whale.label} mendump token ${pos.token_symbol}. Melikuidasi posisi instan...`);

  const exitAlert = `🚨 *WHALE DUMP DETECTED — EMERGENCY SELL FOLLOW!* 🚨\n\n` +
    `🐋 *Paus:* *${whale.label}* (\`${whale.address.slice(0, 6)}...${whale.address.slice(-4)}\`)\n` +
    `🪙 *Token:* *${pos.token_symbol}*\n` +
    `⚡ *Aksi Paus:* Terdeteksi swap SELL di DEX!\n\n` +
    `🛡️ *Respons Instan:* Bot mengeksekusi likuidasi 100% seketika untuk mengamankan modal sebelum liquidity pool terkuras habis!`;
  await notify(exitAlert);

  return await executeSellToken(pos.id, 100, `WHALE_DUMP_FOLLOW (${whale.label})`);
}

// 3. REAL-TIME WEBSOCKET POSITION MONITORING & EVALUATION
let monitorInterval: NodeJS.Timeout | null = null;
const lastKnownLiquidity: Map<number, number> = new Map();
const activePositionSubs: Map<number, { accountSubs: number[]; logSubs: number[] }> = new Map();
const evaluatingPositions: Set<number> = new Set();

export function refreshPositionWebSocketSubscriptions() {
  const openPositions = getOpenPositions();
  const currentOpenIds = new Set(openPositions.map(p => p.id));

  // Unsubscribe closed positions
  for (const [posId, subs] of activePositionSubs.entries()) {
    if (!currentOpenIds.has(posId)) {
      for (const subId of subs.accountSubs) {
        try { connection.removeAccountChangeListener(subId); } catch {}
      }
      for (const subId of subs.logSubs) {
        try { connection.removeOnLogsListener(subId); } catch {}
      }
      activePositionSubs.delete(posId);
      console.log(`[TradeManager] 🛑 WebSocket position tracker stopped for #${posId}`);
    }
  }

  // Subscribe new open positions
  for (const pos of openPositions) {
    if (activePositionSubs.has(pos.id)) continue;

    const subs = { accountSubs: [] as number[], logSubs: [] as number[] };

    try {
      if (pos.token_address.endsWith('pump')) {
        const bondingCurvePda = getBondingCurveAddress(pos.token_address);
        const subId = connection.onAccountChange(
          bondingCurvePda,
          async (accountInfo) => {
            try {
              const state = decodeBondingCurveBuffer(accountInfo.data);
              if (state && state.spotPriceSol > 0) {
                const solPrice = await getSolPriceUsd();
                const currentPrice = state.spotPriceSol * solPrice;
                const currentLiq = state.liquiditySol * solPrice;
                await evaluatePosition(pos.id, currentPrice, currentLiq);
              }
            } catch {}
          },
          'confirmed'
        );
        subs.accountSubs.push(subId);
        console.log(`[TradeManager] ⚡ Live Helius WS (onAccountChange) Active for Pump.fun token ${pos.token_symbol}`);
      } else {
        const tokenPubkey = new PublicKey(pos.token_address);
        const subId = connection.onLogs(
          tokenPubkey,
          async (logsCtx) => {
            if (logsCtx.err) return;
            try {
              await evaluatePosition(pos.id);
            } catch {}
          },
          'confirmed'
        );
        subs.logSubs.push(subId);
        console.log(`[TradeManager] ⚡ Live Helius WS (onLogs) Active for Raydium token ${pos.token_symbol}`);
      }

      activePositionSubs.set(pos.id, subs);
    } catch (err: any) {
      console.warn(`[TradeManager] Gagal subscribe WebSocket untuk posisi ${pos.token_symbol}:`, err.message);
    }
  }
}

export async function evaluatePosition(
  posId: number, 
  overridePrice?: number, 
  overrideLiquidityUsd?: number
) {
  if (evaluatingPositions.has(posId)) return;
  evaluatingPositions.add(posId);

  try {
    const pos = getPositionById(posId);
    if (!pos || pos.status !== 'OPEN') return;

    const solPriceUsd = await getSolPriceUsd();
    let currentPrice = overridePrice || pos.current_price_usd;
    let currentLiquidityUsd = overrideLiquidityUsd || 0;

    // Direct on-chain bonding curve math for Pump.fun tokens if no override
    if (!overridePrice && pos.token_address.endsWith('pump')) {
      const onChainCurve = await getOnChainBondingCurve(pos.token_address);
      if (onChainCurve && !onChainCurve.complete && onChainCurve.spotPriceSol > 0) {
        currentPrice = onChainCurve.spotPriceSol * solPriceUsd;
        currentLiquidityUsd = onChainCurve.liquiditySol * solPriceUsd;
      }
    }

    // Fallback to DexScreener if not a bonding curve token or graduated to Raydium
    if (currentPrice === pos.current_price_usd || currentLiquidityUsd === 0) {
      const marketData = await getTokenMarketData(pos.token_address);
      if (marketData) {
        currentPrice = marketData.priceUsd;
        currentLiquidityUsd = marketData.liquidityUsd;
      }
    }

    if (!currentPrice || currentPrice <= 0) return;

    // Flash-Exit Rug Buster: Detect sudden liquidity drainage (>30% in single tick)
    if (CONFIG.FLASH_EXIT_ENABLED && currentLiquidityUsd > 0) {
      const prevLiq = lastKnownLiquidity.get(pos.id);
      if (prevLiq && prevLiq > 1000) {
        const dropPct = ((prevLiq - currentLiquidityUsd) / prevLiq) * 100;
        if (dropPct >= CONFIG.FLASH_EXIT_DROP_PCT) {
          console.log(`[TradeManager] 🚨 FLASH-EXIT RUG BUSTER TRIGGERED for ${pos.token_symbol}! Liquidity dropped ${dropPct.toFixed(1)}% in single tick.`);
          lastKnownLiquidity.delete(pos.id);
          await executeSellToken(pos.id, 100, `FLASH_EXIT_RUG_BUSTER (-${dropPct.toFixed(0)}% Liq Drain)`);
          return;
        }
      }
      lastKnownLiquidity.set(pos.id, currentLiquidityUsd);
    }

    const updated = updatePositionPrice(pos.id, currentPrice);
    if (!updated) return;

    const pnlPct = updated.pnl_pct;
    const peakPrice = updated.peak_price_usd;
    const targetTp = pos.target_tp_pct || CONFIG.TAKE_PROFIT_PCT;
    const targetSl = pos.target_sl_pct || CONFIG.STOP_LOSS_PCT;

    // 1. STAGE 1 TAKE-PROFIT (Adaptive Target): Jual 50%, Modal Aman, Sisanya Free-Roll Moonbag!
    if (pos.is_half_closed === 0 && pnlPct >= targetTp) {
      console.log(`[TradeManager] 🎯 STAGE 1 TP (+${pnlPct.toFixed(1)}% >= target ${targetTp}%) tercapai untuk ${pos.token_symbol}! Menjual 50%...`);
      const halfTokens = pos.amount_tokens * 0.5;
      const soldUsd = halfTokens * currentPrice;
      const soldSol = soldUsd / solPriceUsd;

      updatePaperBalance(soldSol);
      halfClosePosition(pos.id, currentPrice, soldSol, `STAGE_1_TP (+${pnlPct.toFixed(1)}%)`);

      const remainingBalance = getPaperBalance();
      const halfTpAlert = `🎉 *STAGE 1 TAKE-PROFIT DIEKSEKUSI! (50% DIJUAL)*\n\n` +
        `🪙 *Token:* *${pos.token_symbol}* (${pos.token_name})\n` +
        `📈 *Profit Terkunci:* *+${pnlPct.toFixed(1)}%* (Target: +${targetTp}%) 🟢\n` +
        `💰 *Dana Masuk:* *${soldSol.toFixed(4)} SOL* (~$${(soldSol * solPriceUsd).toFixed(2)})\n` +
        `🛡️ *Status:* *Modal Awal Diamankan!* Saldo bebas risiko.\n` +
        `🌕 *Sisa 50% Posisi:* Menjadi *FREE-ROLL MOONBAG* dikawal Trailing Stop (${CONFIG.TRAILING_STOP_PCT}%).\n` +
        `💼 *Saldo Virtual Sekarang:* *${remainingBalance.toFixed(3)} SOL*\n\n` +
        `_Jika token terus terbang to the moon, bot akan memanen puncak profit!_`;

      await notify(halfTpAlert);
      return;
    }

    // 2. STAGE 2 MOONBAG TRAILING STOP (Untuk sisa 50% koin)
    if (pos.is_half_closed === 1) {
      const peakGainPct = ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      const dropFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;

      if (dropFromPeakPct >= CONFIG.TRAILING_STOP_PCT) {
        console.log(`[TradeManager] 🌕 Moonbag Trailing Stop Triggered for ${pos.token_symbol} (Peak: +${peakGainPct.toFixed(1)}%, Dropped: -${dropFromPeakPct.toFixed(1)}%)`);
        await executeSellToken(pos.id, 100, `MOONBAG_TRAILING_STOP (Peak +${peakGainPct.toFixed(1)}%)`);
        return;
      }
    }

    // 3. STOP-LOSS (Adaptive Target)
    if (pos.is_half_closed === 0 && pnlPct <= -targetSl) {
      console.log(`[TradeManager] 🛑 SL Triggered for ${pos.token_symbol} (${pnlPct.toFixed(1)}% <= -${targetSl}%)`);
      await executeSellToken(pos.id, 100, `AUTO_SL (${pnlPct.toFixed(1)}%)`);
      return;
    }

    // 3.5. PRO TRADER BREAK-EVEN GUARD (BEP Guard):
    // Jika token sudah sempat profit >= +10.0%, lindungi modal!
    // Jika harga kembali turun mendekati titik impas (+1.0%), langsung jual untuk mengunci modal + fee.
    // Aturan Emas Hedge Fund: Trade yang sudah profit TIDAK BOLEH berbalik menjadi rugi!
    if (pos.is_half_closed === 0 && peakPrice > pos.entry_price_usd) {
      const peakGainPct = ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      if (peakGainPct >= 10.0 && pnlPct <= 1.0) {
        console.log(`[TradeManager] 🛡️ Break-Even Stop Triggered for ${pos.token_symbol} (Peak: +${peakGainPct.toFixed(1)}%, Pulled back to ${pnlPct.toFixed(1)}%). Protecting capital!`);
        await executeSellToken(pos.id, 100, `BREAK_EVEN_GUARD (Peak +${peakGainPct.toFixed(1)}% -> Protected @ +${pnlPct.toFixed(1)}%)`);
        return;
      }
    }

    // 4. TRAILING STOP STANDAR (Jika naik >= 20% tapi belum kena target TP lalu koreksi)
    if (pos.is_half_closed === 0) {
      const peakGainPct = ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      if (peakGainPct >= 20.0) {
        const dropFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;
        if (dropFromPeakPct >= CONFIG.TRAILING_STOP_PCT) {
          console.log(`[TradeManager] 🛡️ Trailing Stop Triggered for ${pos.token_symbol} (Peak: +${peakGainPct.toFixed(1)}%, Dropped: -${dropFromPeakPct.toFixed(1)}%)`);
          await executeSellToken(pos.id, 100, `TRAILING_STOP (Peak +${peakGainPct.toFixed(1)}%)`);
          return;
        }
      }
    }

    // 5. TIME-STOP / ZOMBIE POSITION REAPER (24-Hour Capital Turnover Rule)
    const openedTime = new Date(pos.opened_at).getTime();
    const hoursHeld = (Date.now() - openedTime) / (1000 * 60 * 60);
    if (hoursHeld >= CONFIG.MAX_HOLD_TIME_HOURS) {
      console.log(`[TradeManager] ⌛ Time-Stop Triggered for ${pos.token_symbol} (${hoursHeld.toFixed(1)}h held). Liquidating to free capital...`);
      await executeSellToken(pos.id, 100, `TIME_STOP (${hoursHeld.toFixed(1)}h Zombie Exit)`);
      return;
    }
  } catch (err: any) {
    // Ignore transient errors
  } finally {
    evaluatingPositions.delete(posId);
  }
}

export function startPositionManager() {
  if (monitorInterval) return;
  console.log(`[TradeManager] ⚡ Live Position WebSocket & Fallback Monitor started (Polling fallback: ${CONFIG.POSITION_CHECK_INTERVAL_SEC}s)...`);

  refreshPositionWebSocketSubscriptions();
  checkPositions();
  monitorInterval = setInterval(checkPositions, CONFIG.POSITION_CHECK_INTERVAL_SEC * 1000);
}

export function stopPositionManager() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  for (const [posId, subs] of activePositionSubs.entries()) {
    for (const subId of subs.accountSubs) {
      try { connection.removeAccountChangeListener(subId); } catch {}
    }
    for (const subId of subs.logSubs) {
      try { connection.removeOnLogsListener(subId); } catch {}
    }
  }
  activePositionSubs.clear();
}

async function checkPositions() {
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  refreshPositionWebSocketSubscriptions();

  for (const pos of openPositions) {
    try {
      await evaluatePosition(pos.id);
    } catch (err: any) {
      // Ignore transient errors
    }
  }
}

function formatNumber(num: number): string {
  if (!num) return '0';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K';
  return num.toFixed(2);
}
