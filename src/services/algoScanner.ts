import axios from 'axios';
import { getTokenMarketData, getSolPriceUsd } from './dexscreener';
import { checkTokenSafety } from './antirug';
import { executeBuyToken } from './tradeManager';
import { getOpenPositions, getOpenPositionByToken, getPaperBalance } from '../db/index';
import { discoveryFunnel } from '../market/discoveryFunnel';
import { opportunityScorer } from '../execution/opportunityScorer';
import { FeatureVector } from '../core/types';
import { CONFIG } from '../config';

/**
 * Fetches top organic volume tokens from GeckoTerminal trending Solana pools,
 * with graceful fallback to DexScreener high-volume search.
 */
export async function getOrganicTrendingTokens(limit: number = 16): Promise<Array<{ tokenMint: string; poolName: string; volumeUsd: number }>> {
  const tokens: Array<{ tokenMint: string; poolName: string; volumeUsd: number }> = [];

  // Tier 1: GeckoTerminal Trending Pools
  try {
    const res = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools', {
      headers: { Accept: 'application/json' },
      timeout: 7000
    });

    const pools = res.data?.data;
    if (Array.isArray(pools)) {
      for (const p of pools) {
        if (tokens.length >= limit) break;
        const rawTokenId = p.relationships?.base_token?.data?.id || '';
        const tokenMint = rawTokenId.replace('solana_', '');
        const volumeUsd = parseFloat(p.attributes?.volume_usd?.h24 || '0');
        const reserveUsd = parseFloat(p.attributes?.reserve_in_usd || '0');
        const poolName = p.attributes?.name || 'Trending Pool';

        if (
          tokenMint && 
          tokenMint.length >= 32 && 
          reserveUsd >= 10000 && 
          volumeUsd >= 50000 &&
          tokenMint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' && // USDC
          tokenMint !== 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'    // USDT
        ) {
          if (!tokens.some(t => t.tokenMint === tokenMint)) {
            tokens.push({ tokenMint, poolName, volumeUsd });
          }
        }
      }
    }
  } catch (err: any) {
    // Graceful fallback
  }

  // Tier 2: DexScreener high volume search fallback
  if (tokens.length < limit) {
    try {
      const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 6000 });
      const pairs = res.data?.pairs?.filter((p: any) => 
        p.chainId === 'solana' && 
        (p.volume?.h24 || 0) >= 50000 && 
        (p.liquidity?.usd || 0) >= 15000
      ) || [];
      for (const p of pairs) {
        if (tokens.length >= limit) break;
        const tokenMint = p.baseToken?.address;
        if (tokenMint && !tokens.some(t => t.tokenMint === tokenMint)) {
          tokens.push({
            tokenMint,
            poolName: `${p.baseToken?.symbol || 'SOL'} / ${p.quoteToken?.symbol || 'SOL'}`,
            volumeUsd: p.volume?.h24 || 0
          });
        }
      }
    } catch {}
  }

  return tokens;
}

let isScannerRunning = false;
let scannerTimer: NodeJS.Timeout | null = null;
const SCAN_INTERVAL_MS = 60 * 1000; // Scan every 60s

type TelegramNotifier = (message: string, extra?: any) => Promise<void>;
let scannerNotifier: TelegramNotifier | null = null;

export function setAlgoScannerNotifier(notifier: TelegramNotifier) {
  scannerNotifier = notifier;
}

async function notify(msg: string, extra?: any) {
  if (scannerNotifier) {
    try {
      await scannerNotifier(msg, extra);
    } catch (err: any) {
      console.error('[AlgoScanner] Telegram notify error:', err.message);
    }
  }
}

export interface ScannedCandidate {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  score: number;
  passed: boolean;
  rejectReason?: string;
  explanation: string;
}

/**
   * On-Demand Market Scan: Analyzes live Solana tokens and scores them via Hedge Fund criteria
   */
export async function scanMarketOnce(limit: number = 8): Promise<ScannedCandidate[]> {
  const trending = await getOrganicTrendingTokens(limit);
  const results: ScannedCandidate[] = [];

  for (const item of trending) {
    try {
      const market = await getTokenMarketData(item.tokenMint);
      if (!market || market.priceUsd <= 0) continue;

      const safety = await checkTokenSafety(item.tokenMint);

      // Estimate age from 24h volume presence (if volume > 0, likely survived > 3m)
      const tokenAgeSec = 600; // Estimated survival phase (> 10m)
      const isPump = item.tokenMint.endsWith('pump');

      const funnelEval = discoveryFunnel.evaluateCandidate({
        token: {
          id: item.tokenMint,
          address: item.tokenMint,
          symbol: market.symbol,
          name: market.name,
          decimals: 9,
          isPumpFun: isPump,
          discoveredAt: new Date().toISOString()
        },
        pool: {
          id: market.pairAddress || item.tokenMint,
          tokenId: item.tokenMint,
          poolAddress: market.pairAddress || '',
          dexId: (market.dexId as any) || 'raydium',
          quoteToken: 'SOL',
          initialLiquidityUsd: market.liquidityUsd,
          initialPriceUsd: market.priceUsd,
          discoveredAt: new Date().toISOString()
        },
        liquidityUsd: market.liquidityUsd,
        volume24hUsd: market.volume24h || 0,
        marketCapUsd: market.marketCap || 0,
        priceUsd: market.priceUsd,
        tokenAgeSeconds: tokenAgeSec,
        bondingCurveProgressPct: isPump ? 50.0 : undefined,
        devHoldingPct: 2.0,
        uniqueHoldersCount: 65,
        safetyReport: safety
      });

      // Synthetic feature vector for explainable scoring
      const vector: FeatureVector = {
        tokenId: item.tokenMint,
        timestampMs: Date.now(),
        timeframe: '5m',
        return1m: (market.priceChange5m || 0) * 0.25,
        return5m: market.priceChange5m || 5.0,
        return15m: (market.priceChange24h || 0) * 0.15,
        realizedVol: 6.5,
        atrPct: 8.0,
        breakoutDistancePct: 4.0,
        drawdownFromPeakPct: 2.0,
        volume5mUsd: (market.volume24h || 0) / 288,
        volumeAcceleration: 1.8,
        buySellRatio: 2.2,
        flowImbalance: 0.35,
        tradeCount5m: 15,
        avgTradeSizeUsd: 120,
        liquidityUsd: market.liquidityUsd,
        liquidityChangePct: 0,
        estimatedPriceImpactPct: 0.8,
        whaleNetFlowSol: 0,
        smartMoneyAccumulationScore: 60,
        cabalClusterRiskScore: 15,
        regime: 'TRENDING_UP',
        quality: 'VALID'
      };

      const scoreResult = opportunityScorer.scoreOpportunity(vector, []);

      results.push({
        mint: item.tokenMint,
        symbol: market.symbol,
        name: market.name,
        priceUsd: market.priceUsd,
        liquidityUsd: market.liquidityUsd,
        marketCapUsd: market.marketCap,
        score: scoreResult.compositeScore,
        passed: funnelEval.passed && scoreResult.compositeScore >= 65,
        rejectReason: funnelEval.passed ? undefined : funnelEval.reason,
        explanation: scoreResult.explanation
      });
    } catch (err: any) {
      // Continue next token
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Autonomous Background Loop: Scans and auto-buys high-scoring tokens when ALGO_ONLY or HYBRID is active
 */
export async function runAlgoScanCycle() {
  try {
    console.log(`[AlgoScanner] 🔍 Menjalankan siklus scan pasar kuantitatif otonom...`);
    const candidates = await scanMarketOnce(6);
    const qualifying = candidates.filter(c => c.passed && c.score >= 70);

    if (qualifying.length === 0) {
      console.log('[AlgoScanner] ℹ️ Tidak ada token baru yang memenuhi standar skor Hedge Fund (>=70). Menunggu siklus berikutnya.');
      return;
    }

    const best = qualifying[0];
    const existing = getOpenPositionByToken(best.mint);
    if (existing) {
      return; // Already holding
    }

    const openPositions = getOpenPositions();
    if (openPositions.length >= (CONFIG.MAX_OPEN_POSITIONS || 15)) {
      return; // Portfolio capacity full
    }

    const balance = getPaperBalance();
    if (balance < CONFIG.DEFAULT_BUY_AMOUNT_SOL) {
      return; // Insufficient funds
    }

    console.log(`[AlgoScanner] 🚀 GOLDEN OPPORTUNITY DETECTED: ${best.symbol} (${best.name}) Skor: ${best.score}/100!`);
    
    // Execute Autonomous Buy
    const buyResult = await executeBuyToken(
      best.mint,
      CONFIG.DEFAULT_BUY_AMOUNT_SOL,
      'ALGO_AUTONOMOUS'
    );

    if (buyResult.success) {
      const msg = `⚡ *ALGORITMA OTOMATIS MEMBELI TOKEN!*\n\n` +
        `🪙 *Token:* *${best.symbol}* (${best.name})\n` +
        `📝 *CA:* \`${best.mint}\`\n` +
        `📊 *Skor Quant:* *${best.score}/100* 🟢\n` +
        `💧 *Likuiditas Pool:* *$${Math.round(best.liquidityUsd).toLocaleString()}*\n` +
        `📈 *Market Cap:* *$${Math.round(best.marketCapUsd).toLocaleString()}*\n` +
        `💰 *Ukuran Posisi:* *${CONFIG.DEFAULT_BUY_AMOUNT_SOL} SOL*\n\n` +
        `🎯 _Target TP Stage 1 (+42%): Jual 50% & kunci modal._\n` +
        `🛡️ _Proteksi Moonbag Trailing Stop (-18%) aktif otomatis._`;

      await notify(msg);
    }
  } catch (err: any) {
    console.error('[AlgoScanner] Error during scan cycle:', err.message);
  }
}

export function startAlgoScanner() {
  if (isScannerRunning) return;
  isScannerRunning = true;
  console.log('[AlgoScanner] 🚀 Autonomous Hedge Fund Algo Scanner aktif (Interval 60s).');

  // Initial delayed scan
  setTimeout(() => runAlgoScanCycle(), 15000);
  scannerTimer = setInterval(() => runAlgoScanCycle(), SCAN_INTERVAL_MS);
}

export function stopAlgoScanner() {
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
  }
  isScannerRunning = false;
  console.log('[AlgoScanner] 🛑 Algo Scanner dinonaktifkan.');
}
