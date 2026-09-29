import { Connection, PublicKey } from '../utils/solanaWeb3';
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
  getLastClosedPosition,
  isCircuitBreakerActive,
  tripCircuitBreaker,
  getDailyStopLossCount,
  getConsecutiveAlgoLosses,
  getEmpiricalKellyStats,
  getDailyRealizedPnl,
  setBalanceClampAlertHandler
} from '../db/index';
import { getTokenMarketData, getSolPriceUsd, calculatePriceImpactPct } from './dexscreener';
import { getOnChainBondingCurve, getBondingCurveAddress, decodeBondingCurveBuffer } from './bondingCurve';
import { checkTokenSafety } from './antirug';
import { getBuyQuote, getSellQuote } from './jupiter';
import { Whale, Position, ExecutionDataReason, ExitClass } from '../types/index';
import { getDedicatedConnection, getDedicatedEndpoint } from './solanaConnection';
import { adaptiveLearningEngine } from '../strategies/adaptiveLearningEngine';
import { simulateRealisticSell, simulateRealisticBuy } from './dexSimulator';
// [EXITFIX] 2026-09-29: single source of truth for fee math + ratchet floor.
// estimateRoundTripFeePct is re-exported so any external importer keeps working.
import { computeRatchetFloorPct } from '../execution/feeModel';
export { estimateRoundTripFeePct } from '../execution/feeModel';
// M3 (2026-09-29): fresh-data entry re-validation at fill time.
// M4 (2026-09-29): honest decision lifecycle journaling.
import { revalidateEntryOnFreshData } from '../execution/entryEngine';
import { DecisionJournal } from '../journal/decisionJournal';
import { getStorageRepository } from '../storage/index';
// O-10 (2026-09-29): autonomy kill-switch — no autonomous buys without oversight.
import { isAutonomousBuyEnabled, getAutonomyDisableReason } from '../core/autonomy';

const positionEndpoint = getDedicatedEndpoint('POSITION_MANAGER');
const wsUrl = positionEndpoint.wsUrl;
const connection = getDedicatedConnection('POSITION_MANAGER');

type TelegramNotifier = (message: string, extra?: any) => Promise<void>;
let telegramNotifier: TelegramNotifier | null = null;
let lastCircuitBreakerNotifyTime = 0;
const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000; // 15 menit

export const ATA_RENT_EXEMPT_SOL = 0.00203928; // Standard Solana rent-exempt minimum for SPL token account (refundable on close)
export const GAS_RESERVE_BUFFER_SOL = 0.015; // Mandatory untouched gas buffer to prevent InsufficientFundsForFee errors

// In-Memory Concurrency Lock & Re-entry Loss Cooldown
const activeOrderTokens = new Set<string>();
// Per-position sell lock: mencegah double-close saat WS tick & heartbeat 3s berlomba (double-sell guard)
const sellingPositionIds = new Set<number>();
const tokenLossCooldownMap = new Map<string, number>();
const LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours cooldown on tokens that suffered dump/SL
// M-4 (2026-09-29): throttle for STALE_FEED warnings (pos.id -> last warn ms)
const staleFeedWarnAt = new Map<number, number>();

// m-1 (2026-09-29): phantom-guard fire metrics. The guard compares the
// POST-impact effective exit price against entry, so on a thin pool it can
// mistake genuine slippage for a fake-feed spike (guard-vs-impact ambiguity).
// Behavior is intentionally UNCHANGED — these counters exist to collect the
// incident data needed before any redesign of the guard.
export const phantomGuardStats = {
  fires: 0,
  lastFireAt: 0,
  lastImpactPct: 0,
  lastEffLiquidityUsd: 0,
  lastSymbol: '',
};

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

export interface DynamicSizingResult {
  allocatedSol: number;
  basePercentSol: number;
  streakDecay: number;
  consecutiveLosses: number;
  rationale: string;
}

// NOTE: estimateRoundTripFeePct lives in src/execution/feeModel.ts (venue-aware)
// and is re-exported at the top of this file for compatibility.

/**
 * Dynamic Equity Sizing with Consecutive Loss Scaling for Algo Bot
 * QUANT-04: Base fraction is now Empirical Kelly (Bayesian blend with a conservative
 * prior) instead of a fixed 5%. Uses realized win rate & payoff from closed positions;
 * falls back to the prior when the sample is small. Bounded [2%, 8%] so noisy
 * early estimates can never dictate reckless size. Anti-martingale loss-streak
 * decay is preserved on top.
 * - Empirical quarter-Kelly on prior (p=35%, b=3.0, weight 20 trades) blended with live stats — fixed 5% was leaving edge on the table
 * - Floor: 0.030 SOL (preserves capital while maintaining viable on-chain trade)
 */
export function getDynamicAlgoBuyAmount(): DynamicSizingResult {
  const balance = getPaperBalance();
  const consecutiveLosses = getConsecutiveAlgoLosses();

  // 1. Base Target: Empirical Kelly fraction of current equity (QUANT-04)
  let baseFraction = 0.05;
  let kellyNote = 'prior 5.0%';
  if (CONFIG.KELLY_SIZING_ENABLED !== false) {
    try {
      const stats = getEmpiricalKellyStats();
      // Bayesian blend: prior (p=35%, b=3.0, weight 20 trades) vs empirical stats
      const priorP = 0.35, priorB = 3.0, priorWeight = 20;
      const w = stats.n / (stats.n + priorWeight);
      const p = w * stats.winRate + (1 - w) * priorP;
      const b = Math.max(0.5, w * stats.payoff + (1 - w) * priorB);
      const kellyF = (p * b - (1 - p)) / b; // f* = (p*b - q) / b
      if (kellyF > 0 && Number.isFinite(kellyF)) {
        const quarterKelly = kellyF * (CONFIG.KELLY_FRACTION || 0.25);
        baseFraction = Math.min(0.08, Math.max(0.02, quarterKelly));
        kellyNote = `empKelly n=${stats.n} p=${p.toFixed(2)} b=${b.toFixed(1)} -> ${(baseFraction * 100).toFixed(1)}%`;
      }
    } catch { /* fall back to prior on DB error */ }
  }
  const rawBaseSol = balance * baseFraction;

  // 2. Minimum Viable Solana Floor: 0.030 SOL (prevents excessive gas fee ratio)
  const MIN_FLOOR_SOL = 0.030;
  // Maximum Cap: up to 8% of balance (lets empirical Kelly breathe), hard ceiling 0.12 SOL
  const MAX_CAP_SOL = Math.min(0.12, Math.max(0.050, balance * 0.08));

  // 3. Loss Streak Decay (Anti-Martingale Defensive Sizing):
  // 0 losses: 1.0x (full conviction)
  // 1 loss: 0.75x (-25% size reduction)
  // 2 losses: 0.56x (-44% size reduction)
  // 3+ losses: minimum floor 0.030 SOL
  const streakDecay = consecutiveLosses > 0 ? Math.pow(0.75, consecutiveLosses) : 1.0;

  let allocatedSol = rawBaseSol * streakDecay;

  // Bound within [MIN_FLOOR_SOL, MAX_CAP_SOL]
  allocatedSol = Math.max(MIN_FLOOR_SOL, Math.min(MAX_CAP_SOL, allocatedSol));
  
  // Guard if balance is low
  if (balance < allocatedSol + 0.005) {
    allocatedSol = Math.max(0.02, balance * 0.5);
  }

  allocatedSol = Math.round(allocatedSol * 1000) / 1000;

  return {
    allocatedSol,
    basePercentSol: Math.round(rawBaseSol * 1000) / 1000,
    streakDecay: Math.round(streakDecay * 100) / 100,
    consecutiveLosses,
    rationale: `Balance: ${balance.toFixed(3)} SOL | Kelly Base: ${(baseFraction * 100).toFixed(1)}% (${kellyNote}) = ${rawBaseSol.toFixed(3)} SOL | Loss Streak: ${consecutiveLosses} (Decay: ${streakDecay.toFixed(2)}x) -> Final: ${allocatedSol} SOL`
  };
}

// 1. EXECUTE BUY (Copy-Trade or Manual)
export async function executeBuyToken(
  tokenMint: string,
  amountSol?: number,
  source: string = 'MANUAL',
  whale?: Whale,
  whaleEntryPriceUsd?: number,
  prefetchedMarketData?: any,
  dataReason?: ExecutionDataReason
): Promise<{ success: boolean; message: string; position?: Position }> {
  // M4 (2026-09-29): honest decision lifecycle. The scanner logs EVALUATED with
  // a decisionId (dataReason.decisionId); every rejection/failure below marks it
  // FAILED, and only a real fill marks it EXECUTED. Manual/sniper buys carry no
  // decisionId — the journal calls become no-ops for them.
  const scanDecisionJournal = new DecisionJournal(getStorageRepository());
  const scanDecisionId = dataReason?.decisionId;
  const markScanDecisionFailed = async (reason: string): Promise<void> => {
    if (!scanDecisionId) return;
    try {
      await scanDecisionJournal.markDecisionOutcome({ decisionId: scanDecisionId, decision: 'FAILED', reason });
    } catch (err: any) {
      console.warn('[TradeManager] markDecisionOutcome(FAILED) error:', err.message);
    }
  };
  // M4: wraps every failure return so the scanner's EVALUATED verdict is always
  // marked FAILED with the reason. Replaces `return { success: false, ... }`.
  const failBuy = async (message: string): Promise<{ success: false; message: string }> => {
    await markScanDecisionFailed(message);
    return { success: false, message };
  };

  // O-10 (2026-09-29): autonomy kill-switch, enforced at the fill site so EVERY
  // autonomous path is covered (scanner, WS stream, any future caller).
  // With TELEGRAM_ADMIN_ID=0 there is zero human oversight — index.ts disables
  // autonomy fail-closed. Manual Telegram buys are explicit admin actions (the
  // admin IS the oversight) and stay allowed.
  const isManualBuy = source === 'MANUAL' || source === 'MANUAL_SNIPER';
  if (!isAutonomousBuyEnabled() && !isManualBuy) {
    const autoMsg = `Autonomous buy dinonaktifkan (fail-closed): ${getAutonomyDisableReason() || 'tanpa oversight'} — manual Telegram tetap boleh`;
    console.error(`[TradeManager] 🛑 ${autoMsg} (source=${source})`);
    return failBuy(autoMsg);
  }

  // Apply Dynamic Equity Sizing if amountSol is not explicitly specified or default
  if (!amountSol || amountSol === CONFIG.DEFAULT_BUY_AMOUNT_SOL) {
    const dynamicSizing = getDynamicAlgoBuyAmount();
    amountSol = dynamicSizing.allocatedSol;
    console.log(`[TradeManager] 💰 Dynamic Sizing Applied: ${amountSol} SOL (${dynamicSizing.rationale})`);
  }

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
    return failBuy(`Circuit breaker aktif (${remainingMins}m tersisa)`);
  }

  // 0. Concurrency Lock: Prevent simultaneous double-orders on the same token
  if (activeOrderTokens.has(tokenMint)) {
    console.log(`[AutoTrade] ⏳ Order untuk ${tokenMint} sedang diproses secara asinkron. Melewati order ganda.`);
    return failBuy('Order token ini sedang diproses');
  }

  // Check if position already open
  const existing = getOpenPositionByToken(tokenMint);
  if (existing) {
    console.log(`[AutoTrade] ℹ️ Token ${existing.token_symbol} (${tokenMint}) sudah aktif di portofolio. Melewati pembelian duplikat.`);
    return failBuy(`Posisi untuk token ${existing.token_symbol} sudah aktif dibuka.`);
  }

  // 0.5. Re-entry Loss Cooldown Guard: Persistent 24-Hour Quarantine from SQLite DB
  const lastClosed = getLastClosedPosition(tokenMint);
  if (lastClosed && lastClosed.closed_at) {
    const msSinceClose = Date.now() - new Date(lastClosed.closed_at).getTime();
    const minsSinceClose = msSinceClose / 60000;
    // F-01 follow-through: quarantine keys off the exit CLASS, not substrings —
    // the old includes('SL')/includes('DUMP') missed FLASH_EXIT_RUG_BUSTER.
    const lastCloseClass = lastClosed.close_reason ? classifyExitReason(lastClosed.close_reason) : 'PROFIT_TAKE';
    const wasForcedExit = lastCloseClass === 'STOP' || lastCloseClass === 'EMERGENCY' || lastCloseClass === 'TIME_STOP';
    if (lastClosed.pnl_pct <= 0 || wasForcedExit) {
      if (minsSinceClose < 1440) { // 24 hours quarantine
        const remainingHours = ((1440 - minsSinceClose) / 60).toFixed(1);
        console.log(`[AutoTrade] 🛡️ Re-entry Guard: Token ${lastClosed.token_symbol} (${tokenMint}) ditutup minus (${lastClosed.pnl_pct.toFixed(1)}%) ${minsSinceClose.toFixed(0)}m lalu. Karantina 24 jam aktif (${remainingHours} jam tersisa).`);
        return failBuy(`Token sedang dalam karantina 24 jam pasca-SL (${remainingHours} jam tersisa)`);
      }
    }
  }

  const cooldownExpiry = tokenLossCooldownMap.get(tokenMint);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const remainingMins = Math.ceil((cooldownExpiry - Date.now()) / 60000);
    console.log(`[AutoTrade] 🛡️ Re-entry Guard: Token ${tokenMint} baru saja dump/loss. Cooldown ${remainingMins}m tersisa.`);
    return failBuy(`Token sedang dalam cooldown pasca-dump (${remainingMins}m tersisa)`);
  }

  activeOrderTokens.add(tokenMint);
  try {

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
    return failBuy('Maksimal posisi aktif portofolio tercapai');
  }

  // HEDGE-FUND RISK 2: Portfolio Heat Cap.
  // 15 positions x 8% sizing = 120% of equity deployable into a book where every
  // memecoin correlates ~0.7 in a selloff. Count-based limits are not enough:
  // cap total deployed notional as % of equity (default 50%).
  //
  // F-05 (2026-09-29): MARK-TO-MARKET equity. The old code valued deployed
  // capital at ENTRY notional, so a book full of underwater positions overstated
  // equity — the heat cap and daily stop were looser than claimed exactly when
  // they mattered most (correlated selloff). Deployed = current market value.
  const riskSolPriceUsd = await getSolPriceUsd().catch(() => 0);
  const mtmValueSol = (pos: Position): number => {
    const px = pos.current_price_usd > 0 ? pos.current_price_usd : pos.entry_price_usd;
    return riskSolPriceUsd > 0 ? (pos.amount_tokens * px) / riskSolPriceUsd : (pos.entry_sol || 0);
  };
  {
    const balanceForHeat = getPaperBalance();
    const deployedSol = openPositions.reduce((sum, pos) => sum + mtmValueSol(pos), 0);
    const equitySol = balanceForHeat + deployedSol;
    const heatCap = CONFIG.MAX_PORTFOLIO_HEAT_PCT || 0.50;
    if (equitySol > 0 && deployedSol / equitySol >= heatCap) {
      console.log(`[AutoTrade] 🛡️ Portfolio Heat Cap: deployed ${deployedSol.toFixed(3)} SOL = ${(deployedSol / equitySol * 100).toFixed(1)}% of equity >= ${(heatCap * 100).toFixed(0)}%. Menolak order baru.`);
      if (shouldNotifyFilterSkip) {
        await notify(
          `⚠️ *ORDER DIBATALKAN: PORTFOLIO HEAT CAP*\n\n` +
          `🔥 *Deployed:* *${deployedSol.toFixed(3)} SOL* (${(deployedSol / equitySol * 100).toFixed(1)}% dari equity, batas ${(heatCap * 100).toFixed(0)}%)\n\n` +
          `_Bot menolak menambah eksposur agar satu selloff terkorelasi tidak menghantam seluruh book._`
        );
      }
      return failBuy('Portfolio heat cap tercapai');
    }
  }

  // HEDGE-FUND RISK 3: Daily Equity Stop (kill switch).
  // The 3-SL circuit breaker counts events; this counts MONEY. If realized net
  // PnL over the last 24h is worse than -8% of equity, no new risk is taken —
  // entries resume automatically tomorrow. Survive first.
  //
  // F-05 (2026-09-29): counts UNREALIZED drawdown too. The old code only looked
  // at realized PnL, so a slow-bleed day with no closes never tripped the stop
  // while new entries kept opening on top of a bleeding book. Conservative by
  // design: open-position MTM is included in full.
  {
    const balanceForStop = getPaperBalance();
    const deployedForStop = openPositions.reduce((sum, pos) => sum + mtmValueSol(pos), 0);
    const equityForStop = balanceForStop + deployedForStop;
    const unrealizedPnlSol = openPositions.reduce((sum, pos) => sum + (mtmValueSol(pos) - (pos.entry_sol || 0)), 0);
    try {
      const daily = getDailyRealizedPnl();
      const totalDrawdownSol = daily.netPnlSol + unrealizedPnlSol;
      const maxDailyLoss = (CONFIG.DAILY_MAX_LOSS_PCT || 0.08) * equityForStop;
      if (totalDrawdownSol <= -maxDailyLoss && equityForStop > 0) {
        console.log(`[AutoTrade] 🛑 DAILY EQUITY STOP: drawdown ${totalDrawdownSol.toFixed(3)} SOL (realized ${daily.netPnlSol.toFixed(3)} + unrealized ${unrealizedPnlSol.toFixed(3)}) <= -${maxDailyLoss.toFixed(3)} SOL (24h). Menghentikan entry baru hari ini.`);
        if (shouldNotifyFilterSkip) {
          await notify(
            `🛑 *DAILY EQUITY STOP TERPICU*\n\n` +
            `📉 *Drawdown 24 jam:* *${totalDrawdownSol.toFixed(3)} SOL* (realized ${daily.netPnlSol.toFixed(3)} + unrealized ${unrealizedPnlSol.toFixed(3)}, batas harian -${maxDailyLoss.toFixed(3)} SOL)\n` +
            `📊 *Win rate 24 jam:* ${daily.winRate} (${daily.winTrades}W/${daily.lossTrades}L dari ${daily.totalTrades} trade)\n\n` +
            `_Bot menghentikan seluruh entry baru hingga 24 jam ke depan demi melindungi modal. Posisi terbuka tetap dikelola exit engine._`
          );
        }
        return failBuy('Daily equity stop aktif');
      }
    } catch {}
  }

  // Check paper balance with ATA rent deposit and gas buffer
  const currentBalance = getPaperBalance();
  const minRequiredBalance = amountSol + CONFIG.ESTIMATED_BUY_FEE_SOL + ATA_RENT_EXEMPT_SOL + GAS_RESERVE_BUFFER_SOL;
  if (currentBalance < minRequiredBalance) {
    const msg = `⚠️ Saldo tidak cukup! Saldo: ${currentBalance.toFixed(3)} SOL, Diperlukan: ${minRequiredBalance.toFixed(3)} SOL (termasuk buffer cadangan ${GAS_RESERVE_BUFFER_SOL} SOL & deposit ATA ${ATA_RENT_EXEMPT_SOL.toFixed(4)} SOL)`;
    if (shouldNotifyFilterSkip) {
      await notify(msg);
    }
    return failBuy(msg);
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
    return failBuy(msg);
  }

  // M7 (2026-09-29): STALE-PRICE GUARD (buy side). getTokenMarketData serves
  // stale cache during 429 backoff; TokenMarketData.fetchedAt records how old
  // this snapshot is. Paper fills on minute-old prices are systematically
  // optimistic (buying a pre-dump price that no longer exists). The sell side
  // already had this guard — the buy side did not.
  const marketDataAgeMs = Date.now() - (marketData.fetchedAt || 0);
  if (!marketData.fetchedAt || marketDataAgeMs > 60_000) {
    const staleMsg = `Data pasar basi (${marketData.fetchedAt ? Math.round(marketDataAgeMs / 1000) + 's' : 'tanpa timestamp'}) — tolak buy (M7 stale guard)`;
    console.log(`[AutoTrade] 🛡️ ${staleMsg} (${marketData.symbol})`);
    return failBuy(staleMsg);
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

  // Construct Transparent Source & Whale Context Section for Notifications
  const sourceInfoSection = whale ? (
    `🐋 *Pemicu Order:* *${whale.label}*\n` +
    `👛 *Dompet Paus:* \`${whale.address.slice(0, 6)}...${whale.address.slice(-4)}\`\n` +
    (whaleEntryPriceUsd && whaleEntryPriceUsd > 0 
      ? `🎯 *Harga Beli Paus:* *${formatPrice(whaleEntryPriceUsd)}*\n` 
      : '') +
    (dataReason?.netBuyFlowSolEst && dataReason.netBuyFlowSolEst > 0 
      ? `💵 *Est. Net Buy Flow:* *+${dataReason.netBuyFlowSolEst.toFixed(1)} SOL*\n` 
      : '') +
    `\n`
  ) : (
    (source && source !== 'MANUAL') ? `🏷️ *Pemicu Order:* ${source}\n\n` : ''
  );

  // Institutional Risk Control 1.5: Narrative / Sector Concentration Shield
  const currentNarrative = extractNarrative(marketData.symbol, marketData.name);
  if (currentNarrative !== 'OTHER') {
    const matchingPositions = openPositions.filter(p => extractNarrative(p.token_symbol, p.token_name) === currentNarrative);
    if (matchingPositions.length >= CONFIG.MAX_POSITIONS_PER_NARRATIVE) {
      console.log(`[AutoTrade] 🛡️ Narrative Shield: Sudah ada ${matchingPositions.length} posisi di sektor ${currentNarrative}. Menolak order untuk mencegah correlated risk.`);
      if (shouldNotifyFilterSkip) {
        await notify(
          `⚠️ *ORDER DIBATALKAN: NARRATIVE SHIELD*\n\n` +
          `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
          `📝 *CA:* \`${tokenMint}\`\n\n` +
          sourceInfoSection +
          `🛡️ *Alasan:* Portofolio sudah memiliki ${matchingPositions.length} koin di sektor *${currentNarrative}* (${matchingPositions.map(p => p.token_symbol).join(', ')}). Bot mencegah risiko kerugian terkorelasi.`
        );
      }
      return failBuy(`Maksimal posisi sektor ${currentNarrative} tercapai`);
    }
  }

  // M3 (2026-09-29): DECISION-FILL DECOUPLING FIX. The scan verdict was made on
  // data fetched 30-60s ago; the fill below uses THIS fresh snapshot. Rebuild a
  // compact feature vector from the fresh data + in-memory tape and re-run the
  // full entry engine — a setup whose rebound already failed must not be bought
  // on a stale PASS.
  const freshEval = await revalidateEntryOnFreshData(marketData, tokenMint);
  if (!freshEval.shouldEnter) {
    const revalMsg = `Setup tak terkonfirmasi pada data fresh: ${freshEval.reason}`;
    console.log(`[AutoTrade] 🛡️ M3 re-validation menolak buy ${marketData.symbol}: ${freshEval.reason}`);
    if (shouldNotifyFilterSkip) {
      await notify(
        `⚠️ *ORDER DIBATALKAN: SETUP KEDALUWARSA (M3)*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `🔍 *Alasan:* ${freshEval.reason}\n\n` +
        `_Verdict dibuat pada data 30-60 detik lalu; pada data fresh saat ini setup tidak lagi lolos gate entry._`
      );
    }
    return failBuy(revalMsg);
  }

  // Pump.fun bonding curve tokens have guaranteed virtual liquidity in the contract (even before Raydium graduation)
  const isPumpFun = tokenMint.endsWith('pump') || marketData.dexId === 'pumpfun';
  // M10 (2026-09-29): FAIL CLOSED on unverified depth. The old code GUESSED
  // 35% of mcap (min $5k) when the on-chain curve fetch failed AND DexScreener
  // reported 0 liquidity — the guess then PASSED the liquidity gate below and
  // understated simulated price impact. If depth can't be verified, no buy.
  if (isPumpFun && !(marketData.liquidityUsd > 0)) {
    const depthMsg = 'Likuiditas tak terverifikasi (curve fetch gagal + DexScreener 0) — tolak buy (M10 fail-closed)';
    console.log(`[AutoTrade] 🛡️ ${depthMsg} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      await notify(
        `⚠️ *ORDER DIBATALKAN: LIKUIDITAS TAK TERVERIFIKASI*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `💧 *Likuiditas Pool:* *tak terverifikasi* (fetch curve on-chain gagal dan DexScreener lapor 0)\n\n` +
        `_Bot menolak menebak depth pool — estimasi 35% mcap yang dulu dipakai bisa menyembunyikan slippage raksasa._`
      );
    }
    return failBuy(depthMsg);
  }
  const effectiveLiquidity = marketData.liquidityUsd > 0 ? marketData.liquidityUsd : 0;

  // Institutional Risk Control 2: Minimum Liquidity & Market Cap Floor
  if (effectiveLiquidity < CONFIG.MIN_LIQUIDITY_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: Likuiditas $${effectiveLiquidity.toFixed(0)} < $${CONFIG.MIN_LIQUIDITY_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: LIKUIDITAS TERLALU RENDAH*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `💧 *Likuiditas Pool:* *$${formatNumber(effectiveLiquidity)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_LIQUIDITY_USD)}*)\n\n` +
        `_Bot menolak membeli di pool illiquid untuk mencegah jebakan slippage dan price impact raksasa._`;
      await notify(alertMsg);
    }
    return failBuy('Likuiditas pool di bawah standar minimum');
  }

  // Institutional Risk Control 2b: Minimum 24h Volume Floor (Active Market Depth)
  if (marketData.volume24h !== undefined && marketData.volume24h > 0 && marketData.volume24h < CONFIG.MIN_VOLUME_24H_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: Volume 24j $${marketData.volume24h.toFixed(0)} < $${CONFIG.MIN_VOLUME_24H_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: VOLUME 24J TERLALU RENDAH*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `📊 *Volume 24 Jam:* *$${formatNumber(marketData.volume24h)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_VOLUME_24H_USD)}*)\n\n` +
        `_Bot menolak token sepi transaksi untuk menghindari risiko token mati / zombie memecoin._`;
      await notify(alertMsg);
    }
    return failBuy('Volume 24 jam token di bawah standar minimum');
  }

  if (marketData.marketCap < CONFIG.MIN_MARKET_CAP_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: MC $${marketData.marketCap.toFixed(0)} < $${CONFIG.MIN_MARKET_CAP_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: MARKET CAP TERLALU KECIL*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `📊 *Market Cap:* *$${formatNumber(marketData.marketCap)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_MARKET_CAP_USD)}*)\n\n` +
        `_Bot menolak token kapitalisasi mikro dengan risiko manipulasi dev tinggi._`;
      await notify(alertMsg);
    }
    return failBuy('Market Cap di bawah standar minimum');
  }

  // Institutional Risk Control 3: Anti-Chase / Price Drift Guard (Pucuk Guard)
  if (whaleEntryPriceUsd && whaleEntryPriceUsd > 0) {
    const driftPct = ((marketData.priceUsd - whaleEntryPriceUsd) / whaleEntryPriceUsd) * 100;
    if (driftPct > CONFIG.MAX_PRICE_DRIFT_PCT) {
      console.log(`[AutoTrade] 🛡️ Anti-Chase triggered: drift +${driftPct.toFixed(1)}% > ${CONFIG.MAX_PRICE_DRIFT_PCT}% (${marketData.symbol})`);
      if (shouldNotifyFilterSkip) {
        const alertMsg = `⚠️ *ORDER DIBATALKAN: ANTI-CHASE GUARD (Pucuk Guard)*\n\n` +
          `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
          `📝 *CA:* \`${tokenMint}\`\n\n` +
          sourceInfoSection +
          `📈 *Harga Pasar Sekarang:* *${formatPrice(marketData.priceUsd)}* (+${driftPct.toFixed(1)}% dari paus)\n` +
          `🛡️ *Batas Toleransi Drift:* *+${CONFIG.MAX_PRICE_DRIFT_PCT}%*\n\n` +
          `_Bot menolak mengejar koin yang sudah terlanjur melambung tinggi agar modal Anda tidak menjadi exit liquidity!_`;
        await notify(alertMsg);
      }
      return failBuy('Harga sudah naik terlalu tinggi dari entry paus');
    }
  }

  // Institutional Risk Control 4: Anti-FOMO Parabolic 5-Minute Spike Guard
  if (marketData.priceChange5m && marketData.priceChange5m > CONFIG.MAX_5M_PRICE_CHANGE_PCT) {
    console.log(`[AutoTrade] 🛡️ Anti-FOMO triggered: 5m change +${marketData.priceChange5m.toFixed(1)}% (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: ANTI-FOMO SPIKE GUARD*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `⚡ *Lonjakan 5 Menit:* *+${marketData.priceChange5m.toFixed(1)}%* (Batas Maksimal: +${CONFIG.MAX_5M_PRICE_CHANGE_PCT}%)\n\n` +
        `_Bot mendeteksi candle parabola vertikal yang rawan aksi dump instan._`;
      await notify(alertMsg);
    }
    return failBuy('Candle 5 menit terlalu overextended');
  }

  // Institutional Risk Control 4b: Upper Wick Rejection Guard (Pucuk Guard)
  if (dataReason?.upperWickRatio !== undefined && dataReason.upperWickRatio > 0.40) {
    console.log(`[AutoTrade] 🛡️ Upper Wick Rejection: Jarum atas ${(dataReason.upperWickRatio * 100).toFixed(1)}% > 40% dari body (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: UPPER WICK REJECTION (Pucuk Guard)*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `📉 *Jarum Atas (Upper Wick):* *${(dataReason.upperWickRatio * 100).toFixed(0)}%* dari body candle (Batas Maksimal: 40%)\n` +
        `🛡️ *Indikasi:* Dev/insider terdeteksi mendistribusikan koin / jualan di pucuk.\n\n` +
        `_Bot menolak membeli koin yang baru saja terbanting dari pucuknya agar modal Anda tidak menjadi exit liquidity!_`;
      await notify(alertMsg);
    }
    return failBuy('Upper wick candle 5 menit terlalu panjang (> 40% dari body)');
  }

  // 2. Anti-Rug Safety Audit (Result from concurrent Promise.all)
  if (!safety.isSafe) {
    console.log(`[AutoTrade] 🛡️ Anti-Rug failed for ${marketData.symbol}: score ${safety.score}/100, risks: ${safety.risks.join(', ')}`);
    if (shouldNotifyFilterSkip) {
      const riskDetails = safety.risks.map(r => `• ${r}`).join('\n');
      const alertMsg = `⚠️ *AUTO-BUY DIBATALKAN (RISIKO TINGGI)*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        sourceInfoSection +
        `🛡️ *Safety Score:* ${safety.score}/100 (Di bawah standar aman)\n\n` +
        `*Penyebab Pembatalan:*\n${riskDetails}\n\n` +
        `_Bot melindungi saldo Anda dari potensi rug pull / honeypot._`;
      await notify(alertMsg);
    }
    return failBuy('Token tidak lolos filter Anti-Rug.');
  }

  // 3. 100% Real DEX Buy Execution (Jupiter live router + AMM Constant Product depth)
  const simBuy = await simulateRealisticBuy(
    tokenMint,
    amountSol,
    marketData.priceUsd,
    solPriceUsd,
    effectiveLiquidity,
    CONFIG.SLIPPAGE_PCT
  );
  // M-1 (exit-risk fix, 2026-09-29): the simulator now FAILS CLOSED on unknown
  // pool depth (LIQUIDITY_UNKNOWN) instead of inventing a $500 pool. Never open
  // a position on an unpriced fill. -- entry team: please review/own this guard.
  if (!simBuy.success) {
    const msg = `Order beli DIBATALKAN (fail-closed): ${simBuy.warning || 'simulasi eksekusi gagal'} — tidak ada fill yang dikarang pada likuiditas unknown.`;
    console.warn(`[TradeManager] ⛔ ${msg} (${tokenMint})`);
    return failBuy(msg);
  }
  const effectiveEntryPriceUsd = simBuy.effectiveEntryPriceUsd;
  const amountTokens = simBuy.tokensAcquired;
  const priceImpactPct = simBuy.priceImpactPct;

  // 4. Deduct Paper Balance (Principal + Real Live On-Chain Network Fee + ATA Rent Deposit)
  const liveBuyFeeSol = simBuy.networkFeeSol;
  const totalBuyDeductionSol = amountSol + liveBuyFeeSol + ATA_RENT_EXEMPT_SOL;
  updatePaperBalance(-totalBuyDeductionSol);

  // Institutional Continuous Conditional Risk/Reward Engine (Self-Learning).
  // M6 (2026-09-29): dropped the banned `absVol * 1.2` synthesis at the call site —
  // the engine ignores both args and returns static 45/9.5 (honest docstring above).
  const absVol = marketData.priceChange5m ? Math.abs(marketData.priceChange5m) : 0;
  const dynamicTargets = adaptiveLearningEngine.getDynamicTpSl(absVol);
  const targetTpPct = dynamicTargets.targetTpPct;
  const targetSlPct = dynamicTargets.targetSlPct;

  // Determine Source Label
  // M5 (2026-09-29): no "Smart Money" framing — this project does not track whale
  // wallets and does not do whale-follow. The whale param is legacy/never set by
  // live callers; kept only so the signature stays compatible.
  let sourceLabel = '⚡ Manual Sniper';
  if (whale) {
    sourceLabel = `🐋 ${whale.label}`;
  } else if (source === 'LIVE_WS_STREAM') {
    sourceLabel = '⚡ Live WebSocket Stream (Helius Sub-Detik)';
  } else if (source === 'ALGO_AUTONOMOUS') {
    sourceLabel = '🔍 Algo Scanner Otonom (Watchdog Cycle)';
  } else if (source === 'MANUAL_SNIPER') {
    sourceLabel = '🎯 Manual Sniper (Telegram UI)';
  } else if (source) {
    sourceLabel = `⚙️ ${source}`;
  }

  // Setup Model Classification
  // M5 (2026-09-29): WHALE_COPY removed — no whale-follow in this project.
  const setup = dataReason?.setupType || (source === 'LIVE_WS_STREAM' ? 'PULLBACK_ABSORPTION' : (source === 'ALGO_AUTONOMOUS' ? 'MOMENTUM_RUNNER' : 'MANUAL_SNIPER'));

  let setupHeader = '🎯 Algorithmic Entry';
  if (setup === 'PARABOLIC_BREAKOUT') {
    setupHeader = '🚀 PARABOLIC BREAKOUT (God Candle Momentum)';
  } else if (setup === 'PULLBACK_ABSORPTION') {
    setupHeader = '📉 PULLBACK ABSORPTION (Diskon Sehat + Rebound)';
  } else if (setup === 'MOMENTUM_RUNNER' || setup === 'QUANT_MOMENTUM') {
    setupHeader = '🔥 ORGANIC RUNNER (Volume Shock & Velocity)';
  } else if (setup === 'MANUAL_SNIPER') {
    setupHeader = '🎯 MANUAL SNIPER (User Executed)';
  }

  const ret5mVal = dataReason?.priceChange5m ?? marketData.priceChange5m;
  const vol5mVal = dataReason?.volume5mUsd ?? marketData.volume5m;
  const ratioVal = dataReason?.buySellRatio ?? (marketData.txns5mSells && marketData.txns5mSells > 0 ? ((marketData.txns5mBuys || 0) / marketData.txns5mSells) : undefined);

  // 5. Create Position in Database
  const entryReasonStr = `${setupHeader}${dataReason?.score ? ` (Score: ${dataReason.score}/100)` : ''}`;
  const position = createPosition({
    token_address: tokenMint,
    token_symbol: marketData.symbol,
    token_name: marketData.name,
    amount_tokens: amountTokens,
    entry_price_usd: effectiveEntryPriceUsd,
    entry_sol: amountSol,
    whale_source: whale ? whale.label : source,
    target_tp_pct: targetTpPct,
    target_sl_pct: targetSlPct,
    entry_reason: entryReasonStr,
    // Hedge-fund provenance: what fired, how strong, in what regime.
    setup_type: setup,
    entry_score: dataReason?.score,
    entry_regime: dataReason?.regime
  });
  refreshPositionWebSocketSubscriptions();

  // M4 (2026-09-29): the fill REALLY happened — only now may the scanner's
  // EVALUATED decision be marked EXECUTED (with position id + timestamp).
  if (scanDecisionId) {
    try {
      await scanDecisionJournal.markDecisionOutcome({
        decisionId: scanDecisionId,
        decision: 'EXECUTED',
        positionId: position.id,
        executedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.warn('[TradeManager] markDecisionOutcome(EXECUTED) error:', err.message);
    }
  }

  const remainingBalance = getPaperBalance();

  // Construct Quantitative Data Reason Section for Telegram
  let dataReasonSection = `\n🧠 *DATA REASON & ALGORITHMIC TRIGGER:*\n` +
    `• Setup Model: *${setupHeader}*\n`;

  if (dataReason?.score !== undefined) {
    dataReasonSection += `• Skor Quant: *${dataReason.score}/100* ${dataReason.minScore ? `(Hurdle: *${dataReason.minScore}*)` : ''} 🟢\n`;
  }
  if (ret5mVal !== undefined) {
    const rvolSnippet = dataReason?.rvol ? ` (RVOL: *${dataReason.rvol.toFixed(1)}x* Shock)` : '';
    dataReasonSection += `• Momentum 5m: *${ret5mVal >= 0 ? '+' : ''}${ret5mVal.toFixed(1)}%*${rvolSnippet}\n`;
  }
  if (dataReason?.priceChange1h !== undefined) {
    dataReasonSection += `• Momentum 1 Jam: *${dataReason.priceChange1h >= 0 ? '+' : ''}${dataReason.priceChange1h.toFixed(1)}%*\n`;
  }
  if (vol5mVal) {
    dataReasonSection += `• Volume 5m: *$${Math.round(vol5mVal).toLocaleString()}*\n`;
  }
  if (ratioVal !== undefined) {
    const buySellCount = (dataReason?.buys5m !== undefined && dataReason?.sells5m !== undefined)
      ? ` (${dataReason.buys5m} Buys / ${dataReason.sells5m} Sells)`
      : (marketData.txns5mBuys && marketData.txns5mSells ? ` (${marketData.txns5mBuys}B / ${marketData.txns5mSells}S)` : '');
    dataReasonSection += `• Order Flow: *${ratioVal.toFixed(1)}x* Dominasi Buyer${buySellCount}\n`;
  }
  if (dataReason?.netBuyFlowSolEst !== undefined && dataReason.netBuyFlowSolEst > 0) {
    dataReasonSection += `• Est. Net Buy Flow: *+${dataReason.netBuyFlowSolEst.toFixed(1)} SOL* (agregat count, bukan tracking wallet)\n`;
  }
  if (dataReason?.drawdownFromPeakPct !== undefined && dataReason.drawdownFromPeakPct > 0) {
    dataReasonSection += `• Retracement Dip: *-${dataReason.drawdownFromPeakPct.toFixed(1)}%* dari peak lokal\n`;
  }
  if (dataReason?.reboundTickPct !== undefined) {
    dataReasonSection += `• Rebound Tick: *${dataReason.reboundTickPct >= 0 ? '+' : ''}${dataReason.reboundTickPct.toFixed(1)}%* Terkonfirmasi\n`;
  }
  if (dataReason?.explanation) {
    dataReasonSection += `• Konfirmasi Algoritma: _"${dataReason.explanation}"_\n`;
  }

  const buyAlert = `🚀 *ORDER BELI BERHASIL DIEKSEKUSI!* (Simulasi $0)\n\n` +
    `🏷️ *Sumber:* ${sourceLabel}\n` +
    `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
    `📝 *CA:* \`${tokenMint}\`\n\n` +
    `📊 *Rincian Order:*\n` +
    `• Nominal: *${amountSol.toFixed(3)} SOL* (~$${(amountSol * solPriceUsd).toFixed(2)})\n` +
    `• Harga Entry: *${formatPrice(effectiveEntryPriceUsd)}*\n` +
    `• Market Cap: *$${formatNumber(marketData.marketCap)}*\n` +
    `• Likuiditas: *$${formatNumber(effectiveLiquidity)}*\n` +
    `• Anti-Rug Score: *${safety.score}/100* (✅ Aman)\n` +
    `• Biaya On-Chain Riil: *${liveBuyFeeSol.toFixed(6)} SOL* (Base 5k lamports + Priority + Jito Tip)\n` +
    `• Sisa Saldo Dummy: *${remainingBalance.toFixed(3)} SOL*\n` +
    dataReasonSection + '\n' +
    `🎯 *Exit:* ratchet trailing 100% (tier +22/+45/+80/+150, floor NET-of-fees kontinu) | 🛑 *Hard SL:* -${targetSlPct}%\n` +
    `_Zombie reaper 2.5j, max-hold ${CONFIG.MAX_HOLD_TIME_HOURS}j. Tidak ada partial TP / moonbag._\n` +
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
  } finally {
    activeOrderTokens.delete(tokenMint);
  }
}

// 2. EXECUTE SELL / CLOSE POSITION

/**
 * F-01/F-06 (2026-09-29): explicit exit classification. Replaces the old
 * case-sensitive regex over free-text `reason`, which misclassified
 * MANUAL_* sells (blocked underwater — the user could not cut loss) and
 * "TIME_STOP (... Zombie Exit)" (capital Z never matched /ZOMBIE/).
 * Order matters: AUTO_SL contains "SL" but is an emergency-class exit.
 */
export function classifyExitReason(reason: string): ExitClass {
  const r = (reason || '').toUpperCase();
  if (r.includes('MANUAL')) return 'MANUAL';
  if (r.includes('FLASH_EXIT') || r.includes('VELOCITY_DUMP') || r.includes('AUTO_SL')) return 'EMERGENCY';
  if (r.includes('STOP_LOSS') || r.includes('STOPLOSS') || /\bSL\b/.test(r)) return 'STOP';
  if (r.includes('ZOMBIE') || r.includes('TIME_STOP') || r.includes('MAX_HOLD')) return 'TIME_STOP';
  return 'PROFIT_TAKE';
}

export async function executeSellToken(
  positionId: number,
  sellPct: number = 100,
  reason: string = 'MANUAL_SELL',
  exitClass?: ExitClass
): Promise<{ success: boolean; message: string }> {
  // D) Per-position concurrency lock: kunci di awal agar WS tick & heartbeat 3s tidak double-sell posisi yang sama
  if (sellingPositionIds.has(positionId)) {
    console.warn(`[TradeManager] ⛔ DOUBLE-SELL GUARD: Posisi #${positionId} sedang dalam proses penjualan (${reason}). Permintaan duplikat ditolak.`);
    return { success: false, message: 'Posisi sedang diproses penjualan (concurrency lock aktif).' };
  }

  const pos = getPositionById(positionId);
  if (!pos || pos.status !== 'OPEN') {
    return { success: false, message: 'Posisi tidak ditemukan atau sudah ditutup.' };
  }

  sellingPositionIds.add(pos.id);
  try {
    // Re-validate status di dalam lock (posisi bisa saja ditutup tepat sebelum lock didapat)
    const lockedPos = getPositionById(positionId);
    if (!lockedPos || lockedPos.status !== 'OPEN') {
      return { success: false, message: 'Posisi tidak ditemukan atau sudah ditutup.' };
    }

    // F-01: resolve the exit class ONCE — every guard below keys off this, never off substrings.
    const cls: ExitClass = exitClass ?? classifyExitReason(reason);

    // Fetch live market data for exit price
    const marketData = await getTokenMarketData(pos.token_address);
    const solPriceUsd = await getSolPriceUsd();
    const isPumpSell = pos.token_address.endsWith('pump');

    // C) Anti stale/fake price: menolak jual pada harga stale ketika market data gagal,
    // kecuali exit emergency yang tetap boleh cut darurat.
    const isEmergencyExit = cls === 'EMERGENCY';
    const marketDataValid = !!(marketData && marketData.priceUsd > 0);

    if (!marketDataValid && !isEmergencyExit) {
      console.warn(`[TradeManager] 🛡️ STALE PRICE BLOCKED for ${pos.token_symbol}: market data DexScreener unavailable/invalid (reason: ${reason}). Jual dibatalkan untuk mencegah eksekusi pada harga palsu/stale.`);
      return { success: false, message: 'Market data unavailable — sell dibatalkan untuk mencegah eksekusi pada harga palsu/stale' };
    }

    // 100% Real DEX Sell Execution (Jupiter live quote + Constant Product AMM depth cap)
    const tokensToSell = pos.amount_tokens * (sellPct / 100);
    // C) Jangan pernah memalsukan depth pool $20000 — pakai likuiditas riil terakhir yang diketahui (fallback 0)
    const lastKnownLiq = lastKnownLiquidity.get(pos.id) || 0;
    let currentPriceUsd: number;
    let effLiquidity: number;
    // M-4 (2026-09-29): second independent price confirmation for emergency
    // exits on a stale feed. Pump tokens get the on-chain bonding curve as the
    // second source; for everything else the simulator's Jupiter live quote
    // (checked via executionMethod below) is the second source.
    let secondPriceConfirmed = marketDataValid;
    if (marketDataValid) {
      currentPriceUsd = marketData!.priceUsd;
      effLiquidity = marketData!.liquidityUsd || lastKnownLiq;
    } else {
      // Emergency exit pada harga stale: izinkan, tapi tetap dengan depth riil terakhir (bukan angka karangan)
      currentPriceUsd = pos.current_price_usd;
      effLiquidity = lastKnownLiq;
      if (isPumpSell) {
        try {
          const curve = await getOnChainBondingCurve(pos.token_address);
          if (curve && !curve.complete && curve.spotPriceSol > 0 && solPriceUsd > 0) {
            currentPriceUsd = curve.spotPriceSol * solPriceUsd;
            effLiquidity = curve.liquiditySol * solPriceUsd;
            secondPriceConfirmed = true;
          }
        } catch { /* curve read failed — stays unconfirmed, tagged below */ }
      }
      console.warn(`[TradeManager] ⚠️ EMERGENCY STALE-PRICE EXIT for ${pos.token_symbol}: market data gagal, jual darurat (${reason}) pada harga $${currentPriceUsd.toFixed(8)} (likuiditas terakhir $${effLiquidity.toFixed(0)}, konfirmasi kedua: ${secondPriceConfirmed ? 'YA' : 'TIDAK'}).`);
    }

    // F-02 (2026-09-29): emergency exits (AUTO_SL / VELOCITY_DUMP / FLASH_EXIT)
    // happen exactly when liquidity evaporates — simulate them with the
    // emergency-dump slippage path (8%+ tolerance, 2-4.5% adverse penalty),
    // not calm-market fills. Paper P&L for the worst exits was systematically optimistic.
    const simResult = await simulateRealisticSell(
      pos.token_address,
      tokensToSell,
      currentPriceUsd,
      solPriceUsd,
      effLiquidity,
      CONFIG.SLIPPAGE_PCT,
      isEmergencyExit
    );

    // M-1 (2026-09-29): the simulator FAILS CLOSED on unknown depth
    // (LIQUIDITY_UNKNOWN) instead of inventing a $500 pool. Never book an
    // exit on an invented fill. Non-emergency exits are refused and retried
    // naturally on the next evaluation cycle (position stays OPEN).
    let effectiveExitPriceUsd: number;
    let actualCreditedSol: number;
    let grossExitSol: number;
    let priceImpactPct: number;
    let sellNetworkFeeSol: number;
    let dexFeeSol: number;
    if (!simResult.success) {
      if (simResult.warning === 'LIQUIDITY_UNKNOWN' && isEmergencyExit) {
        // Disaster path: capital must stay movable even when depth is unknown.
        // Fill with a punitive, EXPLICITLY MARKED haircut — never presented as
        // a clean market exit. Auditable via the [STALE_LIQUIDITY_FILL] reason tag.
        const punitiveHaircutPct = 25.0;
        effectiveExitPriceUsd = currentPriceUsd * (1 - punitiveHaircutPct / 100);
        priceImpactPct = punitiveHaircutPct;
        grossExitSol = (tokensToSell * effectiveExitPriceUsd) / (solPriceUsd > 0 ? solPriceUsd : 1);
        const dexFeePctSL = isPumpSell ? 1.25 : 0.25;
        dexFeeSol = grossExitSol * (dexFeePctSL / 100);
        sellNetworkFeeSol = simResult.networkFeeSol;
        actualCreditedSol = Math.max(0, grossExitSol - dexFeeSol - sellNetworkFeeSol);
        reason = `${reason} [STALE_LIQUIDITY_FILL]`;
        console.error(`[TradeManager] 🚨 STALE_LIQUIDITY_FILL for ${pos.token_symbol}: emergency exit on UNKNOWN depth — punitive -25% fill @ $${effectiveExitPriceUsd.toFixed(8)}, tagged in reason for audit.`);
      } else {
        console.warn(`[TradeManager] ⏸️ EXIT REFUSED (LIQUIDITY_UNKNOWN) for ${pos.token_symbol}: ${simResult.warning || 'simulasi gagal'} — posisi tetap OPEN, retry otomatis pada evaluasi berikutnya.`);
        return { success: false, message: 'Likuiditas pool unknown — exit ditolak (fail-closed), retry otomatis pada evaluasi berikutnya.' };
      }
    } else {
      effectiveExitPriceUsd = simResult.effectiveExitPriceUsd;
      actualCreditedSol = simResult.netSol;
      grossExitSol = simResult.grossSol;
      priceImpactPct = simResult.priceImpactPct;
      sellNetworkFeeSol = simResult.networkFeeSol;
      dexFeeSol = simResult.dexFeeSol;
      // M-4: a Jupiter live quote IS an independent second price source —
      // an emergency exit confirmed by it is not a stale-price fill.
      if (simResult.executionMethod === 'JUPITER_LIVE_QUOTE') secondPriceConfirmed = true;
    }

    // M-4: an emergency exit executed without ANY second confirmation rode on
    // a stale print — tag it so paper P&L never hides the fact.
    if (isEmergencyExit && !marketDataValid && !secondPriceConfirmed && !reason.includes('STALE_PRICE_FILL')) {
      reason = `${reason} [STALE_PRICE_FILL]`;
      console.warn(`[TradeManager] ⚠️ STALE_PRICE_FILL tagged for ${pos.token_symbol}: emergency exit tanpa konfirmasi harga kedua.`);
    }

    // B) REALITY GUARD (anti phantom-exit, dipulihkan dari commit 28cac92):
    // Jika reason adalah take-profit/ratchet/trailing (bukan emergency dump), harga efektif keluar
    // WAJIB di atas entry. Jika tidak, ini phantom spike DexScreener -> tolak jualan, jangan eksekusi.
    // F-01: phantom-exit guard applies ONLY to profit-taking exits. MANUAL sells
    // (user explicitly asked), STOP/EMERGENCY exits and TIME_STOP reaps must
    // always be allowed underwater — blocking them traps capital in losers.
    if (cls === 'PROFIT_TAKE' && effectiveExitPriceUsd <= pos.entry_price_usd) {
      // m-1: record the fire for the guard-vs-impact incident dataset.
      // Behavior intentionally unchanged (see phantomGuardStats docstring).
      phantomGuardStats.fires++;
      phantomGuardStats.lastFireAt = Date.now();
      phantomGuardStats.lastImpactPct = priceImpactPct;
      phantomGuardStats.lastEffLiquidityUsd = effLiquidity;
      phantomGuardStats.lastSymbol = pos.token_symbol;
      console.warn(`[TradeManager] 🛡️ PHANTOM EXIT BLOCKED for ${pos.token_symbol}: reason ${reason} mensyaratkan profit, tapi effective exit price $${effectiveExitPriceUsd.toFixed(8)} <= entry $${pos.entry_price_usd.toFixed(8)} (simulasi padam $${(currentPriceUsd * (1 - priceImpactPct / 100)).toFixed(8)}, impact ${priceImpactPct.toFixed(2)}%, likuiditas $${effLiquidity.toFixed(0)}). [metrics] fires=${phantomGuardStats.fires}. Aborting sell untuk lindungi modal!`);
      return { success: false, message: 'Phantom exit blocked — effective exit price tidak di atas entry price.' };
    }

    // When closing position 100%, Solana runtime reclaims the ATA rent deposit (0.00203928 SOL)
    const isFullClose = sellPct >= 99.9;
    const ataRefundSol = isFullClose ? ATA_RENT_EXEMPT_SOL : 0;
    const totalCreditedSol = actualCreditedSol + ataRefundSol;

    if (simResult.warning) {
      console.warn(`[TradeManager] ⚠️ ${simResult.warning}`);
    }

    // D) closePosition SEBELUM updatePaperBalance: jika DB write gagal lempar exception,
    // saldo belum dikredit sehingga tidak terjadi double-close (balance credited + position still OPEN).
    // Validasi terakhir bahwa posisi memang masih OPEN tepat sebelum tulis.
    const stillOpenPos = getPositionById(pos.id);
    if (!stillOpenPos || stillOpenPos.status !== 'OPEN') {
      console.warn(`[TradeManager] ⛔ DOUBLE-SELL GUARD: Posisi ${pos.token_symbol} (#${pos.id}) sudah ditutup sebelum eksekusi. Penjualan duplikat dibatalkan.`);
      return { success: false, message: 'Posisi sudah ditutup sebelum eksekusi.' };
    }

    const closed = closePosition(pos.id, effectiveExitPriceUsd, actualCreditedSol, `${reason} (${sellPct}%)`, sellNetworkFeeSol);
    if (!closed) {
      console.warn(`[TradeManager] ⛔ closePosition gagal (sudah CLOSED?) untuk ${pos.token_symbol} (#${pos.id}). Saldo tidak dikredit.`);
      return { success: false, message: 'Posisi gagal ditutup; saldo tidak dikredit.' };
    }

    refreshPositionWebSocketSubscriptions();
    updatePaperBalance(totalCreditedSol);
    const newBalance = getPaperBalance();

    const pnlPct = ((effectiveExitPriceUsd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
    const grossPnlSol = grossExitSol - (pos.entry_sol * (sellPct / 100));
    const isProfit = pnlPct >= 0;

  // True Net Fee Accounting with Live Real Fees (Base + Priority + Jito tip + DEX protocol)
  // F-08 (2026-09-29): buy leg uses the same CONFIG estimate the BUY history row
  // records — the old hardcoded 0.00008 understated buy fees ~4x vs the project's
  // own estimate, flattering every reported net P&L.
  const sellGasSol = sellNetworkFeeSol;
  const buyGasSol = CONFIG.ESTIMATED_BUY_FEE_SOL * (sellPct / 100);
  // dexFeeSol resolved above: real simulator value, or the punitive
  // STALE_LIQUIDITY_FILL estimate (explicitly tagged in reason).
  const roundTripFeeSol = buyGasSol + sellGasSol + dexFeeSol;
  const netPnlSol = grossPnlSol - roundTripFeeSol;
  const isNetProfit = netPnlSol >= 0;

  // Institutional Risk Control: 2-Hour Loss Token Cooldown (Anti-Revenge Trading & Knife Catching)
  if (!isProfit || cls === 'STOP' || cls === 'EMERGENCY') {
    tokenLossCooldownMap.set(pos.token_address, Date.now() + LOSS_COOLDOWN_MS);
    console.log(`[TradeManager] 🛡️ Re-entry Guard: Token ${pos.token_symbol} masuk cooldown 2 jam pasca-dump.`);
  }

  // Execution Escalation Log for Emergency Exits
  if (cls === 'STOP' || cls === 'EMERGENCY') {
    console.log(`[TradeManager] ⚡ Emergency Exit detected (${reason}). Escalating priority fee & widening slippage tolerance.`);
  }

  let alertHeader = isProfit ? '🎉 *TAKE PROFIT DIEKSEKUSI!*' : '🛑 *STOP LOSS DIEKSEKUSI!*';
  let noteSection = '';

  if (reason.includes('VELOCITY_DUMP_RESCUE')) {
    alertHeader = '⚡ *EMERGENCY VELOCITY DUMP RESCUE (CUT CEPAT)!*';
    noteSection = `\n⚠️ *Analisis On-Chain (Deteksi Terjun Bebas):*\n` +
      `_Terdeteksi aksi dump dev/cabal mendadak dalam hitungan detik setelah entry. Bot memotong posisi lebih awal di ${pnlPct.toFixed(1)}% tanpa menunggu batas Stop-Loss penuh demi menyelamatkan modal Anda sebelum liquidity pool terkuras!_\n`;
  } else if (reason.includes('FLASH_DUMP_RESCUE')) {
    alertHeader = '⚡ *EMERGENCY FLASH DUMP RESCUE (SLIPPAGE GAP)!*';
    noteSection = `\n⚠️ *Analisis On-Chain (Slippage Gap Down):*\n` +
      `_Token sempat mencatat profit puncak, namun terjadi dump masif on-chain dalam 1 blok yang melompati batas pengaman. Bot langsung melikuidasi darurat di ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% untuk mengamankan sisa modal Anda sebelum rugi fatal terkena Full SL (-${pos.target_sl_pct || CONFIG.STOP_LOSS_PCT}%)._\n`;
  } else if (reason.includes('SL_PLUS') || reason.includes('BREAK_EVEN')) {
    if (isProfit) {
      alertHeader = '💰 *SL PLUS (PROFIT LOCK) DIEKSEKUSI!*';
      noteSection = `\n🛡️ *Prinsip Pro Trader:* _Trade yang sudah profit berhasil diamankan ke dalam saldo (Risk-Free Profit Realization)._\n`;
    } else {
      alertHeader = '⚡ *EMERGENCY SLIPPAGE CUT!*';
      noteSection = `\n⚠️ *Catatan Slippage:* _Harga pasar jatuh menembus floor sebelum sempat dieksekusi. Bot memotong posisi untuk menghindari risiko drawdown lebih dalam._\n`;
    }
  } else if (reason.includes('MOONBAG')) {
    if (isProfit && isNetProfit) {
      alertHeader = '🚀 *MOONBAG PROFIT HARVEST DIEKSEKUSI!*';
      noteSection = `\n🌕 *Strategi Moonbag:* _Sisa posisi 50% berhasil memanen cuan puncak dan diamankan otomatis saat terjadi koreksi harga!_\n`;
    } else if (isProfit) {
      alertHeader = '🛡️ *MOONBAG BEP GUARD (PROTEKSI IMPAS)!*';
      noteSection = `\n🛡️ *Prinsip Proteksi:* _Sisa posisi 50% diamankan di titik impas (BEP) demi melindungi modal awal dari ancaman Full Stop-Loss._\n`;
    } else {
      alertHeader = '⚡ *EMERGENCY SLIPPAGE CUT (MOONBAG BEP)!*';
      noteSection = `\n⚠️ *Catatan Likuiditas:* _Terjadi slippage on-chain saat mengeksekusi proteksi impas (BEP Guard). Bot langsung memotong sisa posisi untuk mencegah drawdown lebih dalam._\n`;
    }
  } else if (reason.includes('TRAILING_STOP') || reason.includes('RUNNER_TRAILING')) {
    alertHeader = isProfit 
      ? '🚀 *TRAILING STOP DIEKSEKUSI!*' 
      : '🛑 *STOP LOSS DIEKSEKUSI!*';
  }

  const sellAlert = `${alertHeader} (Simulasi)\n\n` +
    `🪙 *Token:* *${pos.token_symbol}*\n` +
    `📝 *Alasan:* \`${reason}\`\n\n` +
    `📊 *Hasil Perdagangan (True Net Accounting):*\n` +
    `• PnL %: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%* ${isProfit ? '🟢' : '🔴'}\n` +
    `• Gross PnL: *${grossPnlSol >= 0 ? '+' : ''}${grossPnlSol.toFixed(4)} SOL* (~$${(grossPnlSol * solPriceUsd).toFixed(2)})\n` +
    `• Biaya On-Chain Riil: *-${roundTripFeeSol.toFixed(5)} SOL* (Gas + Priority + Jito + DEX Fee)\n` +
    `• Net PnL Bersih: *${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(4)} SOL* (~$${(netPnlSol * solPriceUsd).toFixed(2)}) ${isNetProfit ? '💰' : '🔻'}\n` +
    `• Modal Posisi: ${pos.entry_sol.toFixed(3)} SOL\n` +
    `• Hasil Penjualan: *${actualCreditedSol.toFixed(4)} SOL*\n` +
    (isFullClose ? `• Refund Deposit ATA Rent: *+${ataRefundSol.toFixed(4)} SOL* (Akun SPL Ditutup)\n` : '') +
    `• Saldo Virtual Sekarang: *${newBalance.toFixed(3)} SOL*\n` +
    noteSection + '\n' +
    `_Riwayat tersimpan ke database._`;

  await notify(sellAlert);

  // Self-Learning Engine Feedback: Adapt strategy weights, TP/SL targets, and entry hurdle
  adaptiveLearningEngine.onTradeClosed({
    positionId: pos.id,
    tokenAddress: pos.token_address,
    tokenSymbol: pos.token_symbol,
    netPnlSol,
    pnlPct,
    reason,
    strategySource: pos.whale_source,
    setupType: pos.setup_type,
    entryScore: pos.entry_score,
    entryRegime: pos.entry_regime,
    holdingDurationSeconds: Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 1000)
  });

  // Institutional Risk Control: Circuit Breaker Max Daily Drawdown / Consecutive Stop-Loss Guard
  // F-03: trip check on any unprofitable exit OR any forced exit class
  // (STOP/EMERGENCY/TIME_STOP) — the count itself comes from getDailyStopLossCount.
  if (CONFIG.CIRCUIT_BREAKER_ENABLED && (!isProfit || cls === 'STOP' || cls === 'EMERGENCY' || cls === 'TIME_STOP')) {
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
  } catch (err: any) {
      // D) Safety net: exception di tengah eksekusi tidak boleh meninggalkan saldo terkredit
      // dengan posisi masih OPEN (double-close) — hubungkan ke caller via failure result.
      console.error(`[TradeManager] 💥 executeSellToken ERROR untuk posisi #${pos.id} (${pos.token_symbol}, reason ${reason}):`, err?.message || err);
      return { success: false, message: `Eksekusi sell gagal: ${err?.message || 'unknown error'}. Saldo & status posisi konsisten (tidak ada double-close).` };
    } finally {
      // D) Lepas lock selalu, walau sukses, gagal, atau exception
      sellingPositionIds.delete(pos.id);
    }
}

// 3. REAL-TIME WEBSOCKET POSITION MONITORING & EVALUATION
let monitorInterval: NodeJS.Timeout | null = null;
const lastKnownLiquidity: Map<number, number> = new Map();
const activePositionSubs: Map<number, { accountSubs: number[]; logSubs: number[] }> = new Map();
const lastWsUpdateTimestamp: Map<number, number> = new Map();
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
      lastWsUpdateTimestamp.delete(posId);
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
                lastWsUpdateTimestamp.set(pos.id, Date.now());
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
              lastWsUpdateTimestamp.set(pos.id, Date.now());
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
    const isPumpEval = pos.token_address.endsWith('pump');
    let currentPrice = overridePrice || pos.current_price_usd;
    let currentLiquidityUsd = overrideLiquidityUsd || 0;

    // M-4 (2026-09-29): a price is only VALID if it came from a FRESH source
    // this cycle: explicit override, pump on-chain curve, or a fresh DexScreener
    // quote. Falling back to pos.current_price_usd means the feed is STALE —
    // price-based exits must NOT fire on a stale print (the rug scenario:
    // price -> 0, feed dies, bot "sells" at the last pre-rug price and books
    // a fictional recovery).
    let marketDataValid = !!overridePrice;

    // Direct on-chain bonding curve math for Pump.fun tokens if no override
    if (!overridePrice && isPumpEval) {
      const onChainCurve = await getOnChainBondingCurve(pos.token_address);
      if (onChainCurve && !onChainCurve.complete && onChainCurve.spotPriceSol > 0) {
        currentPrice = onChainCurve.spotPriceSol * solPriceUsd;
        currentLiquidityUsd = onChainCurve.liquiditySol * solPriceUsd;
        marketDataValid = true;
      }
    }

    // Fallback to DexScreener if not a bonding curve token or graduated to Raydium.
    // M-4: this codebase has no on-chain AMM decoder for Raydium — DexScreener
    // is the only price source there. When it fails, the feed is STALE
    // (the simulator's Jupiter live quote acts as second confirmation at exit).
    if (!marketDataValid) {
      // Always fetch fresh quotes for open active positions (never rely on 12-second stale cache during dump)
      const marketData = await getTokenMarketData(pos.token_address, true);
      if (marketData && marketData.priceUsd > 0) {
        currentPrice = marketData.priceUsd;
        currentLiquidityUsd = marketData.liquidityUsd;
        marketDataValid = true;
      }
    }

    if (!currentPrice || currentPrice <= 0) return;

    // M-4: STALE FEED — suspend ALL price-based exits this cycle. Only the
    // time-based max-hold reaper (not price-based) may still act.
    if (!marketDataValid) {
      const nowStale = Date.now();
      if (nowStale - (staleFeedWarnAt.get(pos.id) || 0) > 5 * 60 * 1000) {
        staleFeedWarnAt.set(pos.id, nowStale);
        console.warn(`[TradeManager] 📡 STALE_FEED for ${pos.token_symbol}: no fresh price source — price-based exits suspended, max-hold reaper only.`);
      }
      const hoursHeldStale = (Date.now() - new Date(pos.opened_at).getTime()) / 3600000;
      if (hoursHeldStale >= CONFIG.MAX_HOLD_TIME_HOURS) {
        await executeSellToken(pos.id, 100, `MAX_HOLD_TIMEOUT (${hoursHeldStale.toFixed(1)}h Exit) [STALE_FEED]`, 'TIME_STOP');
      }
      return;
    }

    // Flash-Exit Rug Buster: Detect sudden catastrophic liquidity drainage (Dev pulling liquidity)
    if (CONFIG.FLASH_EXIT_ENABLED && currentLiquidityUsd > 0) {
      const prevLiq = lastKnownLiquidity.get(pos.id);
      if (prevLiq && prevLiq > 5000) {
        const dropPct = ((prevLiq - currentLiquidityUsd) / prevLiq) * 100;
        // M-2 (2026-09-29): the drop threshold is now a LIVE config knob
        // (FLASH_EXIT_DROP_PCT, default 50.0) — the old hardcoded 50.0 made the
        // knob dead while Telegram claimed ">30%". Genuine rug drain: liquidity
        // dumped past the knob AND collapsed below the $12k floor, so normal
        // whale exits (30-40% pool swings) can't whipsaw the book.
        const flashDropThreshold = CONFIG.FLASH_EXIT_DROP_PCT > 0 ? CONFIG.FLASH_EXIT_DROP_PCT : 50.0;
        if (dropPct >= flashDropThreshold && currentLiquidityUsd < 12000) {
          console.log(`[TradeManager] 🚨 FLASH-EXIT RUG BUSTER TRIGGERED for ${pos.token_symbol}! Liquidity dropped ${dropPct.toFixed(1)}% to $${currentLiquidityUsd.toFixed(0)}.`);
          lastKnownLiquidity.delete(pos.id);
          await executeSellToken(pos.id, 100, `FLASH_EXIT_RUG_BUSTER (-${dropPct.toFixed(0)}% Liq Drain)`, 'EMERGENCY');
          return;
        }
      }
      lastKnownLiquidity.set(pos.id, currentLiquidityUsd);
    }

    // Anti-Flash-Wick Glitch Filter (Reality Guard):
    // If currentPrice represents a sudden anomalous > 200% jump over entry on an illiquid pool or a 4x sudden tick jump, reject the phantom tick.
    // Likuiditas 0/unknown = pool TIDAK TERVERIFIKASI -> anggap TIDAK terpercaya (untrusted).
    // Sebelumnya syarat `currentLiquidityUsd > 0` mematikan filter ini sepenuhnya saat DexScreener
    // tidak melaporkan likuiditas, sehingga phantom tick +2000% lolos dan bisa memicu ratchet exit palsu.
    const theoreticalGainPct = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
    const currentPeak = pos.peak_price_usd || pos.entry_price_usd;
    const jumpFromPeak = currentPeak > 0 ? (currentPrice / currentPeak) : 1;
    const liquidityUntrusted = !(currentLiquidityUsd > 0);
    const lowLiquidityGain = liquidityUntrusted || currentLiquidityUsd < 15000;
    const lowLiquidityJump = liquidityUntrusted || currentLiquidityUsd < 50000;
    if ((theoreticalGainPct > 200.0 && lowLiquidityGain) || (jumpFromPeak > 4.0 && lowLiquidityJump)) {
      console.warn(`[TradeManager] 🛡️ FLASH-WICK GLITCH REJECTED for ${pos.token_symbol}: Price $${currentPrice} (+${theoreticalGainPct.toFixed(0)}%, ${jumpFromPeak.toFixed(1)}x jump) rejected on pool ($${currentLiquidityUsd.toFixed(0)} liquidity, ${liquidityUntrusted ? 'UNKNOWN/UNVERIFIED' : 'verified'})!`);
      return;
    }

    const updated = updatePositionPrice(pos.id, currentPrice);
    if (!updated) return;

    const pnlPct = updated.pnl_pct;
    const peakPrice = updated.peak_price_usd;
    // m-4 (2026-09-29): targetTp REMOVED — decorative variable, never read by
    // any exit logic (the engine is 100% ratchet; there is no TP).
    const targetSl = pos.target_sl_pct || CONFIG.STOP_LOSS_PCT;

    // 1. VELOCITY DUMP RESCUE (Strict Anti-Rug / Honeypot Early Cut)
    const ageSec = (Date.now() - new Date(pos.opened_at).getTime()) / 1000;
    const isFreshCollapse = (ageSec <= 90 && pnlPct <= -14.0);
    const isPlungeDrop = (pnlPct <= -10.0 && pos.current_price_usd > 0 && ((pos.current_price_usd - currentPrice) / pos.current_price_usd) * 100 >= 12.0);

    if (isFreshCollapse || isPlungeDrop) {
      const reasonDetail = isFreshCollapse 
        ? `Fresh collapse (${pnlPct.toFixed(1)}% in ${ageSec.toFixed(0)}s < 90s)` 
        : `Plunge drop (${pnlPct.toFixed(1)}% with severe tick velocity)`;
      console.log(`[TradeManager] ⚡ VELOCITY DUMP RESCUE triggered for ${pos.token_symbol}: ${reasonDetail}`);
      await executeSellToken(pos.id, 100, `VELOCITY_DUMP_RESCUE (${reasonDetail})`, 'EMERGENCY');
      return;
    }

    // 2. HARD STOP-LOSS (Strict Institutional Hard Ceiling)
    if (pnlPct <= -targetSl) {
      console.log(`[TradeManager] 🛑 HARD SL Triggered for ${pos.token_symbol} (${pnlPct.toFixed(1)}% <= -${targetSl}%)`);
      await executeSellToken(pos.id, 100, `AUTO_SL (${pnlPct.toFixed(1)}%)`, 'EMERGENCY');
      return;
    }

    // 3. INSTITUTIONAL DYNAMIC RATCHET TRAILING STOP (100% Single-Exit, Max Power Law Engine)
    // No partial sales! 100% bag captures exponential runs, Stop-Loss ratchets up like a one-way ladder.
    //
    // M-3/F-09 (2026-09-29): CONTINUOUS floor via computeRatchetFloorPct —
    // floor(peak) = max(guarantee(peak), peak - trail(peak)) + feeBuffer, with
    // guarantee ramping 3.5% -> 25% over [22,45) and 25/50/100 segment minimums
    // above. No cliffs at 22/45/80/150 (see src/execution/feeModel.ts).
    //
    // QUANT-01 (net-of-fees floors): round-trip execution cost (venue-aware DEX
    // fee + network fees as % of position) is ADDED to every floor, so a
    // "locked" level is genuinely profitable. The old +3.5% gross BEP lock
    // netted ~+0.6% after fees — an illusion of safety.
    //
    // QUANT-02 (adaptive trailing): trail-back width scales with peak gain
    // (volatility proxy). Width = 10% + 5% of peak gain, clamped [10%, 20%].
    if (peakPrice > pos.entry_price_usd) {
      const peakGainPct = ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      const ratchetFloorPct = computeRatchetFloorPct(peakGainPct, pos.entry_sol, isPumpEval);
      if (ratchetFloorPct !== null && pnlPct <= ratchetFloorPct) {
        const tier = peakGainPct >= 150 ? 'T4_MEGA' : peakGainPct >= 80 ? 'T3_SUPER' : peakGainPct >= 45 ? 'T2_SOLID' : 'T1_BEP';
        const ratchetReason = `RATCHET_${tier}_EXIT (Peak +${peakGainPct.toFixed(1)}% -> Floor +${ratchetFloorPct.toFixed(1)}% net)`;
        console.log(`[TradeManager] 🎯 DYNAMIC RATCHET TRAILING STOP TRIGGERED for ${pos.token_symbol}! (Peak: +${peakGainPct.toFixed(1)}%, Floor: +${ratchetFloorPct.toFixed(1)}% net, Exit: +${pnlPct.toFixed(1)}%)`);
        await executeSellToken(pos.id, 100, ratchetReason, 'PROFIT_TAKE');
        return;
      }
    }

    // 4. SMART ZOMBIE / TIME-STOP REAPER v2 (Fast Capital Turnover)
    // QUANT-03: the legacy [-6%, +4%] band missed "failed breakouts" — positions that peaked
    // (+8%..+22%) but decayed without ever reaching a ratchet tier, then sat on dead capital
    // until the 12h max-hold. Dead money has opportunity cost: recycle it.
    // Threshold scales with peak achievement: min(12%, max(4%, peakGain * 0.5)).
    const openedTime = new Date(pos.opened_at).getTime();
    const hoursHeld = (Date.now() - openedTime) / (1000 * 60 * 60);
    const peakGainPctZombie = peakPrice > pos.entry_price_usd
      ? ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100
      : 0;
    const zombieCeilPct = Math.min(12, Math.max(4, peakGainPctZombie * 0.5));
    // m-2 (2026-09-29): lower bound -9.0% (was -6.0%) to close the dead zone
    // [-9.5%, -6%) where a stagnant loser was touched by neither the reaper
    // nor the hard SL (-9.5%) — dead capital the reaper exists to recycle.
    if (hoursHeld >= 2.5 && pnlPct >= -9.0 && pnlPct <= zombieCeilPct) {
      console.log(`[TradeManager] ⌛ ZOMBIE TIME-STOP v2: ${pos.token_symbol} held for ${hoursHeld.toFixed(1)}h, peak +${peakGainPctZombie.toFixed(1)}% decayed to ${pnlPct.toFixed(1)}% (stagnant band ≤ +${zombieCeilPct.toFixed(1)}%). Liquidating 100% to rotate capital.`);
      await executeSellToken(pos.id, 100, `ZOMBIE_TIME_STOP (${hoursHeld.toFixed(1)}h Stagnant Exit)`, 'TIME_STOP');
      return;
    }

    // Hard ceiling timeout — F-11 (2026-09-29): single source of truth is
    // CONFIG.MAX_HOLD_TIME_HOURS (default 24h). The old hardcoded 12.0 made the
    // config knob dead and disagreed with the heartbeat reaper path.
    if (hoursHeld >= CONFIG.MAX_HOLD_TIME_HOURS) {
      console.log(`[TradeManager] ⌛ MAX HOLD TIME REACHED for ${pos.token_symbol} (${hoursHeld.toFixed(1)}h held). Liquidating 100%...`);
      await executeSellToken(pos.id, 100, `MAX_HOLD_TIMEOUT (${hoursHeld.toFixed(1)}h Exit)`, 'TIME_STOP');
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
  console.log('[TradeManager] ⚡ Live Position Event-Driven WebSocket Engine aktif (Fallback timeout: 35s).');

  // m-7/F-13 (2026-09-29): route balance-clamp incidents to Telegram — a clamp
  // means the accounting went negative, which must be investigated, not hidden.
  setBalanceClampAlertHandler((info) => {
    notify(
      `🚨 *BALANCE CLAMP AKTIF (mungkin bug akuntansi!)*\n\n` +
      `Upaya saldo: *${info.attempted.toFixed(4)} SOL* → dijepit ke *${info.clampedTo.toFixed(4)} SOL*\n` +
      `Delta tersembunyi: *${info.hiddenDelta.toFixed(4)} SOL*\n\n` +
      `_Saldo tidak boleh negatif. Rekonsiliasi vs trade_history — kemungkinan double-debit._`
    ).catch(() => {});
  });

  refreshPositionWebSocketSubscriptions();
  checkPositions();
  // Heartbeat cadence is configurable via POSITION_CHECK_INTERVAL_SEC.
  // NOTE: the .env/CONFIG key exists (default 2s) but was previously ignored —
  // the interval was hardcoded to 3000ms. It is now honored, clamped to
  // [1.5s, 30s] so a misconfigured env cannot starve the event loop.
  const intervalMs = Math.min(30_000, Math.max(1_500, (CONFIG.POSITION_CHECK_INTERVAL_SEC || 3) * 1_000));
  monitorInterval = setInterval(checkPositions, intervalMs);
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
  lastWsUpdateTimestamp.clear();
}

/**
 * Evaluates a single open position for the heartbeat loop.
 * Extracted from checkPositions so positions can be evaluated CONCURRENTLY:
 * a sequential `for` loop meant one hung RPC (getOnChainBondingCurve /
 * getSolPriceUsd / evaluatePosition) stalled evaluation of every other
 * position in the 3s heartbeat, and the interval itself piled up.
 *
 * Every failure path is guarded with try/catch + Promise.allSettled at the call
 * site so a single rejected promise can never abort the whole sweep.
 */
async function evaluatePositionForHeartbeat(pos: Position, now: number, wsSilenceFallbackMs: number): Promise<void> {
  // 1. Time-Stop / Zombie Position Reaper (24-Hour Turnover)
  const openedTime = new Date(pos.opened_at).getTime();
  const hoursHeld = (now - openedTime) / (1000 * 60 * 60);
  if (hoursHeld >= CONFIG.MAX_HOLD_TIME_HOURS) {
    console.log(`[TradeManager] ⌛ Time-Stop Triggered for ${pos.token_symbol} (${hoursHeld.toFixed(1)}h held). Liquidating to free capital...`);
    await executeSellToken(pos.id, 100, `TIME_STOP (${hoursHeld.toFixed(1)}h Zombie Exit)`, 'TIME_STOP');
    return;
  }

  // 2. Active position evaluation: For Pump.fun, WS onAccountChange provides real-time quotes.
  // For Raydium DEX tokens, ensure fallback polling runs at least every 6s so Stop-Loss is never delayed
  const lastWs = lastWsUpdateTimestamp.get(pos.id) || 0;
  const isPump = pos.token_address.endsWith('pump');
  const maxSilenceMs = isPump ? wsSilenceFallbackMs : 6_000;
  if (now - lastWs < maxSilenceMs) {
    return;
  }

  // 3. Quiet Fallback: Direct RPC getAccountInfo for Pump.fun tokens (0 DexScreener HTTP)
  if (isPump) {
    const curve = await getOnChainBondingCurve(pos.token_address);
    if (curve && !curve.complete && curve.spotPriceSol > 0) {
      const solPrice = await getSolPriceUsd();
      lastWsUpdateTimestamp.set(pos.id, now);
      await evaluatePosition(pos.id, curve.spotPriceSol * solPrice, curve.liquiditySol * solPrice);
      return;
    }
  }

  // Raydium / DEX quiet fallback
  lastWsUpdateTimestamp.set(pos.id, now);
  await evaluatePosition(pos.id);
}

/**
 * Runs at most `maxConcurrency` tasks in flight at once (sliding window).
 * Bounded (not unbounded Promise.all) so a large open-position set cannot
 * fire dozens of simultaneous RPC calls and trip the Helius rate limiter.
 * Each task is catch-wrapped so one rejected/hung RPC never aborts the sweep.
 */
async function runWithBoundedConcurrency<T>(items: T[], maxConcurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue: T[] = [...items];
  const inFlight = new Set<Promise<void>>();

  const launchNext = (): void => {
    while (queue.length > 0 && inFlight.size < maxConcurrency) {
      const item = queue.shift()!;
      const task = worker(item)
        .catch(() => {
          // Per-position isolation: a rejected or hung RPC for one position
          // must never abort evaluation of the others (previously the whole
          // `for` loop's try/catch swallowed per-iteration errors; this keeps
          // that resilience while removing the sequential stall).
        })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
  };

  launchNext();
  while (inFlight.size > 0) {
    // Safe to race: every task above is catch-wrapped, so none can reject.
    await Promise.race([...inFlight]);
    launchNext();
  }
}

/**
 * Event-Driven Position Fallback Check:
 * Only triggers quiet RPC queries if a position has received ZERO WebSocket ticks for >35 seconds,
 * UNLESS the position is already in profit (peak > entry), in which case it is evaluated actively!
 *
 * Positions are evaluated CONCURRENTLY (bounded to 5 in flight) so a single
 * hung/slow RPC cannot stall the heartbeat loop for every other position.
 */
async function checkPositions() {
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  refreshPositionWebSocketSubscriptions();

  const now = Date.now();
  const WS_SILENCE_FALLBACK_MS = 35_000; // 35 seconds

  // Bounded concurrency: max 5 simultaneous position evaluations.
  await runWithBoundedConcurrency(openPositions, 5, (pos) =>
    evaluatePositionForHeartbeat(pos, now, WS_SILENCE_FALLBACK_MS)
  );
}

function formatNumber(num: number): string {
  if (!num) return '0';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K';
  return num.toFixed(2);
}

export function formatPrice(val: number): string {
  if (!val || isNaN(val)) return '$0.00';
  if (val < 0.000001) return '$' + val.toExponential(3);
  if (val < 0.01) return '$' + val.toFixed(6);
  if (val < 1) return '$' + val.toFixed(4);
  return '$' + val.toFixed(2);
}
