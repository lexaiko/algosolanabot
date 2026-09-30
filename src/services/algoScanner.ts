import axios from 'axios';
import { getTokenMarketData, getMultiTokenMarketData, getSolPriceUsd } from './dexscreener';
import { checkTokenSafety } from './antirug';
import { executeBuyToken, getDynamicAlgoBuyAmount, classifyExitReason } from './tradeManager';
import { getOpenPositions, getOpenPositionByToken, getLastClosedPosition, getPaperBalance, isTokenBlacklisted } from '../db/index';
import { discoveryFunnel } from '../market/discoveryFunnel';
import { opportunityScorer } from '../execution/opportunityScorer';
import { entryEngine } from '../execution/entryEngine';
import { adaptiveLearningEngine } from '../strategies/adaptiveLearningEngine';
import { addTokenToWatchlist } from './marketStreamer';
import { markContinuationConsumed } from '../execution/continuationTracker';
import { FeatureVector, StrategySignal } from '../core/types';
import { CONFIG } from '../config';
import { tokenTape, tapeVolume5mNormalized, tapeReturnPerMinutePct } from '../market/tokenTape';
import { DecisionJournal } from '../journal/decisionJournal';
import { getStorageRepository } from '../storage/index';
// O-10 (2026-09-29): autonomy kill-switch — no autonomous buys without oversight.
import { isAutonomousBuyEnabled, getAutonomyDisableReason } from '../core/autonomy';

/**
 * Multi-Stream Candidate Ingestion with Institutional Upstream Quality Filtering:
 * 1. Collects candidates from Raydium v3 Pools by 24h Volume, Raydium v3 Pools
 *    by 24h APR (momentum-first: fresh volatility for a trading/scalping
 *    pullback-absorption strategy; transfer-fee tokens excluded), and
 *    GeckoTerminal Solana Trending Pools pages 1-4 (on-chain DEX activity).
 *    M8 (2026-09-29): the DexScreener token-BOOSTS feed was REMOVED — it is a
 *    PAID ads endpoint, and the old docstring's "NOT paid ads" claim was false.
 *    Feeding paid placements into the candidate pool is systematic adverse
 *    selection (promotion/dump schemes buy their way in).
 * 2. Enriches with batch DexScreener market data.
 *    m16 (2026-09-29): the legacy SQLite whale-queue ingestion was REMOVED —
 *    this project does not track whale wallets; the queue was a dead concept.
 * 3. Discards 100% of micro-liquidity (<$35k) traps upfront.
 * 4. Sorts genuine runners by 5m volume & velocity descending.
 */
export async function getOrganicTrendingTokens(limit: number = 18): Promise<Array<{
  tokenMint: string;
  poolName: string;
  volumeUsd: number;
  volume5m: number;
  priceChange5m: number;
  priceChange1h: number;
  pairAddress?: string;
  /** 2026-09-30 (supervisor): which discovery feed first surfaced this mint.
   *  'raydium_vol' | 'raydium_apr' | 'gecko_trending' | 'unknown'.
   *  First-seen wins when a mint appears in multiple feeds. Used for
   *  discovery-source attribution in the decision journal (which feed's
   *  pool is toxic vs productive). */
  source: string;
  /** GRADUATION LANE (2026-09-30): true for fresh Raydium graduates
   *  (pump.fun migrations < 6h old). They bypass the upstream quality gate
   *  and are evaluated through the graduation funnel lane. */
  isFreshGraduate?: boolean;
}>> {
  const isExcluded = (mint: string) => {
    if (!mint) return true;
    if (
      mint === 'So11111111111111111111111111111111111111112' || // WSOL
      mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || // USDC
      mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' || // USDT
      mint === '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' || // RAY
      mint === 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' ||   // JUP
      isTokenBlacklisted(mint)
    ) return true;

    // Strict 24-Hour Quarantine (1440m) for any token with a forced or losing exit.
    // m6 (2026-09-29): keys off ExitClass via classifyExitReason (STOP /
    // EMERGENCY / TIME_STOP) — the old includes('SL')/includes('DUMP') substring
    // check missed FLASH_EXIT_RUG_BUSTER, ZOMBIE_* and TIME_STOP/MAX_HOLD exits.
    // Consistent with the buy-path quarantine in executeBuyToken.
    const lastClosed = getLastClosedPosition(mint);
    if (lastClosed && lastClosed.closed_at) {
      const msSince = Date.now() - new Date(lastClosed.closed_at).getTime();
      const minsSince = msSince / 60000;
      const lastCloseClass = lastClosed.close_reason ? classifyExitReason(lastClosed.close_reason) : 'PROFIT_TAKE';
      const wasForcedExit = lastCloseClass === 'STOP' || lastCloseClass === 'EMERGENCY' || lastCloseClass === 'TIME_STOP';
      if (lastClosed.pnl_pct <= 0 || wasForcedExit) {
        if (minsSince < 1440) return true; // Exclude from candidate ingestion
      }
    }
    return false;
  };

  // 2026-09-30 (supervisor): mint -> first-seen discovery source, for
  // attribution. First-seen wins; fetch order = raydium_vol, raydium_apr,
  // gecko_trending (priority order).
  const rawMints = new Map<string, string>();
  const tagMint = (mint: string, source: string) => {
    if (!rawMints.has(mint)) rawMints.set(mint, source);
  };

  // 1a. Raydium Official v3 Pools by 24h Volume (Pure on-chain DEX AMM leaders, ZERO keywords!)
  try {
    const rayRes = await axios.get('https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=40&page=1', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const pools = rayRes.data?.data?.data || [];
    for (const p of pools) {
      if (p.mintA?.address && !isExcluded(p.mintA.address)) tagMint(p.mintA.address, 'raydium_vol');
      if (p.mintB?.address && !isExcluded(p.mintB.address)) tagMint(p.mintB.address, 'raydium_vol');
    }
  } catch (err: any) {
    console.warn('[AlgoScanner] Raydium v3 pools unavailable:', err.message);
  }

  // 1b (2026-09-29): Raydium v3 Pools by 24h APR — momentum-first discovery.
  // The volume-sorted feed above yields liquid but "loyo" majors; a
  // pullback-absorption (trading, not investing — scalping OK) strategy needs
  // tokens that are moving NOW. High-APR pools are where fresh volatility
  // lives. Pre-filtered loosely here (tvl >= $20k, 24h volume >= $10k,
  // transfer-fee tokens excluded as honeypot hygiene); the strict upstream
  // quality gate ($35k liq / $30k vol24h) still applies after DexScreener
  // enrichment, so nothing weak reaches scoring.
  try {
    const aprRes = await axios.get('https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=apr24h&sortType=desc&pageSize=40&page=1', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const pools = aprRes.data?.data?.data || [];
    for (const p of pools) {
      const tvl = p.tvl || 0;
      const volQ = p.day?.volumeQuote || 0;
      if (tvl < 20000 || volQ < 10000) continue;
      for (const m of [p.mintA, p.mintB]) {
        if (!m?.address || isExcluded(m.address)) continue;
        const tags: string[] = m.tags || [];
        if (tags.includes('hasTransferFee')) continue; // honeypot hygiene
        tagMint(m.address, 'raydium_apr');
      }
    }
  } catch (err: any) {
    console.warn('[AlgoScanner] Raydium v3 APR pools unavailable:', err.message);
  }

  // 2. GeckoTerminal Multi-Page Trending Pools (Solana network-wide on-chain velocity across Raydium, Orca, Meteora)
  // NOTE: axios `timeout` alone proved unreliable through some egress proxies (observed a 51s hang
  // on a 4.5s timeout), so a hard abort via AbortController is enforced as well.
  // (2026-09-29): 2 -> 4 pages. Trending is the most strategy-aligned source
  // for pullback-absorption; deeper pages catch runners before they cool off.
  try {
    const geckoFetch = (page: number) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4500);
      return axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`, {
        headers: { 'Accept': 'application/json' },
        timeout: 4500,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer)).catch(() => ({ data: { data: [] } }));
    };
    const [p1, p2, p3, p4] = await Promise.all([geckoFetch(1), geckoFetch(2), geckoFetch(3), geckoFetch(4)]);
    const geckoPools = [...(p1.data?.data || []), ...(p2.data?.data || []), ...(p3.data?.data || []), ...(p4.data?.data || [])];
    for (const pool of geckoPools) {
      const baseId = pool.relationships?.base_token?.data?.id?.replace('solana_', '');
      if (baseId && !isExcluded(baseId)) {
        tagMint(baseId, 'gecko_trending');
      }
    }
  } catch (err: any) {
    console.warn('[AlgoScanner] GeckoTerminal trending pools unavailable:', err.message);
  }

  // m16 (2026-09-29): legacy whale-queue ingestion REMOVED. This project does
  // not track whale wallets and does no whale-follow; ingesting the queue as
  // candidates was a dead concept kept alive by habit.

  const allCandidateMints = Array.from(rawMints.keys());
  if (allCandidateMints.length === 0) return [];

  // Batch query DexScreener in 3 parallel chunks of 30 (up to 90 candidate tokens analyzed!
  // (2026-09-29): raised 60 -> 90 to cover the new APR-momentum source; 3 HTTP
  // requests per 10-min cycle is far inside DexScreener's free rate limit.)
  const chunks: string[][] = [];
  for (let i = 0; i < allCandidateMints.length && chunks.length < 3; i += 30) {
    chunks.push(allCandidateMints.slice(i, i + 30));
  }
  const batchResults = await Promise.all(
    chunks.map(c => getMultiTokenMarketData(c))
  );
  const marketMap = new Map(batchResults.flatMap(m => [...m.entries()]));

  // Upstream Quality Gate: Discard micro-liquidity traps upfront!
  const validRunners: Array<{
    tokenMint: string;
    poolName: string;
    volumeUsd: number;
    volume5m: number;
    priceChange5m: number;
    priceChange1h: number;
    pairAddress?: string;
    source: string;
    isFreshGraduate?: boolean;
  }> = [];

  for (const mint of allCandidateMints) {
    const m = marketMap.get(mint);
    if (!m) continue;

    const liq = m.liquidityUsd || 0;
    const vol24h = m.volume24h || 0;
    const vol5m = m.volume5m || 0;
    const ret5m = m.priceChange5m || 0;
    const ret1h = m.priceChange1h || 0;

    // Upstream Quality Gate: Minimum $35k liquidity, $30k 24h volume, and NOT in bleeding 1h dump (ret1h >= -5.0%)
    if (liq >= 35000 && vol24h >= 30000 && ret1h >= -5.0) {
      validRunners.push({
        tokenMint: mint,
        poolName: `${m.symbol} / SOL`,
        volumeUsd: vol24h,
        volume5m: vol5m,
        priceChange5m: ret5m,
        priceChange1h: ret1h,
        pairAddress: m.pairAddress,
        source: rawMints.get(mint) || 'unknown'
      });
    }
  }

  // Sort by Positive Momentum Velocity & Volatility (Favors genuine uptrend runners over bleeding dumps)
  // m17 (2026-09-29): the old Math.max(0.1, momentum) collapsed every
  // negative-momentum token to 0.1 — dumps were never deprioritized vs flat
  // tokens. Raw momentum now sorts dumps to the bottom honestly.
  validRunners.sort((a, b) => {
    const momA = (a.priceChange5m * 2.0 + a.priceChange1h * 0.8);
    const momB = (b.priceChange5m * 2.0 + b.priceChange1h * 0.8);
    const scoreA = momA * Math.log10(Math.max(10, a.volume5m));
    const scoreB = momB * Math.log10(Math.max(10, b.volume5m));
    return scoreB - scoreA;
  });

  const sliced = validRunners.slice(0, limit);

  // GRADUATION LANE (2026-09-30): inject fresh Raydium graduates. Migration
  // tokens sit in the WS watchlist with a growing tape but were NEVER
  // evaluated for entry — the scanner only scored discovery-feed tokens.
  // Research 2026-09-30 (n=68): pool mentah = kuburan (median 4 buyer),
  // tapi token yang lolos filter atensi punya 11.8% excursion 2x+ dengan
  // median 94 menit ke 2x — scan cycle 10 menit bisa nangkep. Graduates
  // bypass the upstream quality gate (liq $35k / vol24h $30k — a minutes-old
  // pool cannot have 24h volume by construction); their lane gates are the
  // graduation funnel (liq >= $15k, safety gate, no 24h-vol bar) + the
  // continuation model's 3-confirmation proof at entry. Capped to bound
  // per-cycle API load; first-seen attribution preserved (source stays
  // 'migration' only when the mint wasn't already tagged by a feed).
  try {
    const { getFreshGraduates } = await import('./marketStreamer');
    const graduates = getFreshGraduates();
    const seenMints = new Set(sliced.map(r => r.tokenMint));
    let injected = 0;
    for (const g of graduates) {
      if (injected >= 10) break;
      if (seenMints.has(g.tokenMint) || isExcluded(g.tokenMint)) continue;
      seenMints.add(g.tokenMint);
      injected++;
      sliced.push({
        tokenMint: g.tokenMint,
        poolName: `${g.symbol} / SOL`,
        volumeUsd: 0,
        volume5m: 0,
        priceChange5m: 0,
        priceChange1h: 0,
        pairAddress: g.pairAddress,
        source: rawMints.get(g.tokenMint) || 'migration',
        isFreshGraduate: true
      });
    }
    // Mark graduates that ALSO surfaced via discovery feeds (first-seen-wins
    // keeps their feed source for attribution, but the lane flag still applies).
    for (const r of sliced) {
      if (!r.isFreshGraduate && graduates.some(g => g.tokenMint === r.tokenMint)) {
        r.isFreshGraduate = true;
      }
    }
    if (injected > 0) {
      console.log(`[AlgoScanner] 🎓 Graduation lane: ${injected} fresh graduate(s) di-inject ke evaluasi siklus ini.`);
    }
  } catch (err: any) {
    console.warn('[AlgoScanner] Graduation lane injection gagal:', err.message);
  }

  return sliced;
}

let isScannerRunning = false;
let scannerTimer: NodeJS.Timeout | null = null;
// O-20 (2026-09-29): shutdown guard — set by stopAlgoScanner; runAlgoScanCycle
// must not fire a buy once shutdown has begun.
let isShuttingDown = false;
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10m gentle background watchdog sync (Live trading handled by marketStreamer WS)

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
  category: 'BUY_READY' | 'PULLBACK_WATCH' | 'DISCARDED';
  ret5m: number;
  ret1h: number;
  buys5m: number;
  sells5m: number;
  volume5mUsd?: number;
  regime: string;
  entryMode?: 'PULLBACK_ABSORPTION' | 'MOMENTUM_CONTINUATION';
  /** 2026-09-30 (supervisor): first-seen discovery feed for this mint
   *  ('raydium_vol' | 'raydium_apr' | 'gecko_trending' | 'unknown'). */
  discoverySource?: string;
  /** GRADUATION LANE (2026-09-30): true when this candidate passed via the
   *  fresh-graduate lane (confirmed MOMENTUM_CONTINUATION, score gate
   *  bypassed — the 3-confirmation proof is the conviction, not the
   *  Goldilocks composite). Lets the qualifying filter admit it without
   *  lowering the bar for the standard lane. */
  gradLane?: boolean;
  /** M4: decision-journal id of the EVALUATED log, passed to executeBuyToken
   *  so the fill (or rejection) can mark it EXECUTED / FAILED. */
  decisionId?: string;
}

/**
   * On-Demand Market Scan: Analyzes live Solana tokens and scores them via Hedge Fund criteria
   */
export async function scanMarketOnce(limit: number = 8): Promise<ScannedCandidate[]> {
  const trending = await getOrganicTrendingTokens(limit);
  const results: ScannedCandidate[] = [];

  // Single Batch HTTP query for all candidates (90%+ HTTP traffic eliminated!)
  const mints = trending.map(t => t.tokenMint);
  const marketMap = await getMultiTokenMarketData(mints);

  for (const item of trending) {
    try {
      let market = marketMap.get(item.tokenMint) || await getTokenMarketData(item.tokenMint);

      // Fast on-chain fallback for Pump.fun tokens if DexScreener has not indexed yet.
      // C2 FIX (2026-09-29): the old code INVENTED a full market snapshot here
      // (priceChange5m: 3.5, volume1h/5m as fractions of liquidity, txns 20/6,
      // fake pair age) — values tuned to PASS the entry gates, so a token with
      // ZERO measured data could reach ENTRY. Now: real bonding-curve fields only
      // (price/liquidity); momentum, volume and flow stay UNKNOWN (undefined).
      // The candidate is quarantined to tape observation until DexScreener indexes
      // it — it is recorded below but never scored on invented data.
      let marketDataUnindexed = false;
      if (!market && item.tokenMint.endsWith('pump')) {
        try {
          const { getOnChainBondingCurve } = await import('./bondingCurve');
          const curve = await getOnChainBondingCurve(item.tokenMint);
          if (curve && curve.spotPriceSol > 0) {
            const solPrice = await getSolPriceUsd();
            market = {
              address: item.tokenMint,
              symbol: 'PUMP',
              name: 'Pump.fun Token',
              priceUsd: curve.spotPriceSol * solPrice,
              priceNative: curve.spotPriceSol,
              liquidityUsd: curve.liquiditySol * solPrice,
              fdv: curve.marketCapSol * solPrice,
              marketCap: curve.marketCapSol * solPrice,
              pairAddress: item.tokenMint,
              dexId: 'pumpfun',
              url: `https://pump.fun/${item.tokenMint}`,
              priceChange24h: 0,
              priceChange5m: undefined,
              volume24h: undefined,
              volume1h: undefined,
              volume5m: undefined,
              txns5mBuys: undefined,
              txns5mSells: undefined,
              pairCreatedAt: undefined,
              // M7: real curve fields only — timestamped like any market snapshot.
              fetchedAt: Date.now()
            };
            marketDataUnindexed = true;
          }
        } catch {}
      }

      if (!market || market.priceUsd <= 0) continue;

      // INSTITUTIONAL TAPE: record this observation, then prefer REAL rolling
      // features over synthetic derivations. Fed by WS ticks (watchlist) and
      // these 10-min snapshots (all scanned tokens).
      tokenTape.record(item.tokenMint, market.priceUsd, market.volume24h || 0, market.liquidityUsd || 0);

      // C2 quarantine: observe via tape, do NOT score until real market data exists.
      if (marketDataUnindexed) {
        console.log(`[AlgoScanner] ⏳ ${item.tokenMint.slice(0, 8)}... belum ter-index DexScreener (momentum/volume/flow unknown) — observasi tape dulu, scoring ditunda.`);
        continue;
      }
      const tape = tokenTape.getFeatures(item.tokenMint);
      const tapeReady = tape.hasTape && tape.points >= 2;

      const safety = await checkTokenSafety(item.tokenMint);

      // m5 (2026-09-29): token age UNKNOWN fails closed. The old default of 600s
      // let age-less tokens sail through the 180s anti-genesis gate — a token
      // whose pair creation time is unknown must not be scored.
      let tokenAgeSec: number | undefined = undefined;
      if (market.pairCreatedAt) {
        tokenAgeSec = Math.max(1, Math.floor((Date.now() - market.pairCreatedAt) / 1000));
      }
      if (tokenAgeSec === undefined) {
        console.log(`[AlgoScanner] ⏳ ${item.tokenMint.slice(0, 8)}... umur token unknown (pairCreatedAt tak ada) — tolak (fail closed).`);
        continue;
      }

      const isPump = item.tokenMint.endsWith('pump');
      let bondingCurvePct: number | undefined = undefined;
      if (isPump) {
        try {
          const { getOnChainBondingCurve } = await import('./bondingCurve');
          const curve = await getOnChainBondingCurve(item.tokenMint);
          if (curve) {
            if (curve.complete) {
              bondingCurvePct = 100.0; // Graduated and migrated to DEX
            } else {
              const realSol = Number(curve.realSolReserves) / 1e9;
              bondingCurvePct = Math.min(100, Math.max(0, (realSol / 85.0) * 100));
            }
          }
        } catch {}
        // m4 (2026-09-29): curve fetch FAILED fails closed. The old fallback of
        // 50.0 sat inside the [15, 85] funnel gate — an unverifiable curve
        // passed the safety gate by invention.
        if (bondingCurvePct === undefined) {
          console.log(`[AlgoScanner] ⛔ ${item.tokenMint.slice(0, 8)}... bonding curve tak terverifikasi (fetch gagal) — tolak (fail closed).`);
          continue;
        }
      }

      // M5+M6 (2026-09-29): DELETED the fabricated "holder metrics". The old
      // code computed devHoldingPct = min(top10 * 0.08, 6.0) (capped below the
      // 8.0 gate — could never fire) and uniqueHoldersCount = max(30, vol/1500)
      // (a volume gate in disguise), then labeled them "Real holder metrics
      // from anti-rug audit". We measure neither; funnel STAGEs 4/5 are gone
      // and the volume bar is explicit in CONFIG.MIN_VOLUME_24H_USD.

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
        bondingCurveProgressPct: bondingCurvePct,
        safetyReport: safety,
        // GRADUATION LANE (2026-09-30): fresh graduates get liq >= $15k,
        // no 24h-volume bar, safety gate stays.
        lane: item.isFreshGraduate ? 'graduation' : 'standard'
      });

      // Real Microstructure Feature Vector computed from live DexScreener & on-chain data.
      // C3 FIX (2026-09-29): ONE honest rule for the ratio. "No sells measured" is
      // NOT "infinite buy dominance" — the old code invented 3.0 here (2.5 on the WS
      // path, 2.0 in the Telegram reason), all tuned to PASS the buy-dominance gate.
      // When sells5m == 0 or flow is unknown, the ratio is UNDEFINED and downstream
      // gates fail closed; flowImbalance already answers dominance without invention.
      const txnsUnknown = market.txns5mBuys === undefined || market.txns5mSells === undefined;
      const buys5m = market.txns5mBuys ?? 0;
      const sells5m = market.txns5mSells ?? 0;
      const tradeCount5m = buys5m + sells5m;
      const buySellRatio: number | undefined =
        (!txnsUnknown && sells5m > 0) ? (buys5m / sells5m) : undefined;
      const flowImbalance = tradeCount5m > 0 ? (buys5m - sells5m) / tradeCount5m : 0;
      // M1 (2026-09-29): the tape's interval volume is normalized to a 5-minute
      // equivalent by ACTUAL elapsed minutes (tapeVolume5mNormalized). The old
      // code annualized the raw ~10-minute delta x12, inflating
      // volumeAcceleration ~2x and weakening the R1 absorption gate to ~0.75x
      // of its design (plus 2x-inflated avgTradeSize/netBuyFlow/BUY_PRESSURE).
      // Null (unmeasurable) stays undefined -> scorer Volume 0 pts, R1 fails
      // closed (C4 semantics preserved).
      const volume5mUsd: number | undefined = tapeVolume5mNormalized(tape) ?? market.volume5m;
      const volume1hUsd: number | undefined = market.volume1h;
      const volumeAcceleration: number | undefined =
        (volume5mUsd !== undefined && volume1hUsd !== undefined && volume1hUsd > 0)
          ? Math.min(10, (volume5mUsd * 12) / volume1hUsd)
          : undefined;

      const ret5m = market.priceChange5m || 0;
      // Realized vol from the tape when mature; otherwise a same-scale proxy.
      const realizedVol = tape.realizedVolPct ?? Math.max(2.0, Math.abs(ret5m) * 1.25);
      const atrPct = Math.max(3.0, realizedVol * 1.2);

      // Buy-pressure ESTIMATION (honest labels — 2026-09-29).
      // We do NOT track whale wallets. Both fields below are heuristics derived
      // from aggregate buy/sell counts, documented as estimates, and left
      // undefined when the trade sample is too thin to say anything.
      // m2 (2026-09-29): no $180 literal — fall back to the cached SOL price.
      const solPriceVal = (market.priceNative && market.priceNative > 0) ? (market.priceUsd / market.priceNative) : await getSolPriceUsd();
      // m15 (2026-09-29): no $80 invented trade size — unknown stays unknown
      // (netBuyFlowSolEst goes undefined instead of being built on a guess).
      const avgTradeSizeUsd: number | undefined = (tradeCount5m > 0 && volume5mUsd !== undefined) ? volume5mUsd / tradeCount5m : undefined;
      const avgTradeSizeSol: number | undefined = (avgTradeSizeUsd !== undefined && solPriceVal > 0) ? (avgTradeSizeUsd / solPriceVal) : undefined;
      const netTrades = Math.max(0, buys5m - sells5m);
      const netBuyFlowSolEst = (buySellRatio !== undefined && buySellRatio >= 1.5 && tradeCount5m >= 10 && avgTradeSizeSol !== undefined)
        ? Math.round(netTrades * avgTradeSizeSol * 10) / 10
        : undefined;
      // C3: buyPressureScore from measured flow only. The old code let an INVENTED
      // ratio (3.0) push this to 90 on "no sells measured". Now: ratio undefined →
      // judge by flowImbalance (honest); thin sample → undefined (fail closed).
      const buyPressureScore = tradeCount5m >= 10
        ? (buySellRatio !== undefined
            ? (buySellRatio >= 1.8 ? 90 : (buySellRatio >= 1.3 ? 75 : 45))
            : (flowImbalance >= 0.6 ? 90 : (flowImbalance >= 0.3 ? 75 : 45)))
        : undefined;

      // Construct Strategy Signals for Multi-Factor Consensus
      const tokenSym = market.symbol || item.poolName || 'UNKNOWN';
      const signals: StrategySignal[] = [];
      if (volumeAcceleration !== undefined && volumeAcceleration >= 1.6 && ret5m >= 2.5) {
        signals.push({
          signalId: `sig_${item.tokenMint.slice(0, 6)}_${Date.now()}_mom`,
          tokenId: item.tokenMint,
          tokenSymbol: tokenSym,
          strategyName: 'MOMENTUM',
          strategyVersion: '1.0',
          direction: 'BUY',
          confidence: Math.min(1.0, volumeAcceleration / 3.0),
          regime: 'TRENDING_UP',
          invalidationPriceUsd: market.priceUsd * 0.9,
          targetTpPct: 25,
          targetSlPct: 8,
          suggestedHoldingPeriodMinutes: 15,
          featureSnapshot: {},
          // M11: all three scanner signals derive from the SAME 5m DexScreener
          // window — tagged honestly so the consensus bonus is not paid in full.
          sourceTag: 'dexscreener-5m',
          generatedAt: new Date().toISOString()
        });
      }
      // C3: FLOW signal from measured dominance only. Zero-sell case judged by
      // flowImbalance on the same scale (never an invented ratio).
      const flowSignalStrength = buySellRatio !== undefined
        ? buySellRatio
        : (flowImbalance >= 0.6 ? 2.0 : 0);
      if (flowSignalStrength >= 1.6 && tradeCount5m >= 8) {
        signals.push({
          signalId: `sig_${item.tokenMint.slice(0, 6)}_${Date.now()}_flow`,
          tokenId: item.tokenMint,
          tokenSymbol: tokenSym,
          strategyName: 'FLOW_IMBALANCE',
          strategyVersion: '1.0',
          direction: 'BUY',
          confidence: Math.min(1.0, flowSignalStrength / 3.0),
          regime: 'TRENDING_UP',
          invalidationPriceUsd: market.priceUsd * 0.9,
          targetTpPct: 20,
          targetSlPct: 7,
          suggestedHoldingPeriodMinutes: 10,
          featureSnapshot: {},
          // M11: all three scanner signals derive from the SAME 5m DexScreener
          // window — tagged honestly so the consensus bonus is not paid in full.
          sourceTag: 'dexscreener-5m',
          generatedAt: new Date().toISOString()
        });
      }
      if ((netBuyFlowSolEst ?? 0) >= 2.0) {
        signals.push({
          signalId: `sig_${item.tokenMint.slice(0, 6)}_${Date.now()}_buypressure`,
          tokenId: item.tokenMint,
          tokenSymbol: tokenSym,
          strategyName: 'BUY_PRESSURE',
          strategyVersion: '1.0',
          direction: 'BUY',
          confidence: 0.85,
          regime: 'TRENDING_UP',
          invalidationPriceUsd: market.priceUsd * 0.92,
          targetTpPct: 30,
          targetSlPct: 6,
          suggestedHoldingPeriodMinutes: 20,
          featureSnapshot: {},
          // M11: all three scanner signals derive from the SAME 5m DexScreener
          // window — tagged honestly so the consensus bonus is not paid in full.
          sourceTag: 'dexscreener-5m',
          generatedAt: new Date().toISOString()
        });
      }

      // Pullback & rebound state: REAL tape only. There is no synthetic fallback:
      // C1 (2026-09-29) deleted the old branch that invented drawdownFromPeakPct
      // and return1m from ret5m alone while the tape was immature — the token is
      // skipped (continue) before reaching here until the tape matures.
      // Note: ret1h is NOT fabricated from 24h; when unknown it falls back to 0
      // for DISPLAY only — but the exhaustion veto fails closed on unknown
      // (m13): an unmeasurable 1h window cannot prove "not exhausted".
      let drawdownFromPeakPct: number;
      // M2 (2026-09-29): per-minute rebound rate (%/min), normalized by actual
      // minutes between tape points. UNDEFINED when unmeasurable — entryEngine
      // R4 fails closed (reject) on undefined.
      let return1m: number | undefined;
      let upperWickRatio: number | undefined;

      if (tapeReady) {
        drawdownFromPeakPct = tape.drawdownFromPeakPct;
        // M2: returnSinceLastPct spans minutesSincePrevPoint minutes (~10 on the
        // scanner path) — it is NOT a 1-minute tick. The old code fed the raw
        // ~10m return into R4's per-minute bar (+0.3%), making the rebound gate
        // ~10x weaker than designed. Normalized to %/min here.
        return1m = tapeReturnPerMinutePct(tape) ?? undefined;
        if (tape.upperWickRatio !== null) upperWickRatio = tape.upperWickRatio;
      } else {
        // C1 FIX (2026-09-29) — FAIL CLOSED. The old code invented drawdownFromPeakPct
        // and return1m here (the two DEFINING inputs of PULLBACK_ABSORPTION) from a
        // single 5m return while the tape was immature — manufacturing the exact
        // setup the model needs out of one number. Its comment even claimed
        // "no invented drawdown" while inventing both. Now: no tape → no pullback
        // scoring at all. The observation was already recorded above, so the token
        // becomes scorable on a later cycle once the tape matures.
        console.log(`[AlgoScanner] ⏳ ${item.tokenMint.slice(0, 8)}... tape belum matang (${tape.points} poin) — observasi dulu, scoring ditunda.`);
        continue;
      }

      const ret1hKnown = market.priceChange1h !== undefined;
      const ret1h = market.priceChange1h ?? 0;

      // Real execution economics: price impact of OUR reference buy size on THIS
      // pool (constant-product approximation). The old hardcoded 0.8 made the
      // >3.5% invalidation gate meaningless.
      const refBuyUsd = (CONFIG.DEFAULT_BUY_AMOUNT_SOL || 0.05) * solPriceVal;
      const estimatedPriceImpactPct = market.liquidityUsd > 0
        ? Math.min(10, (refBuyUsd / (market.liquidityUsd * 0.5)) * 100)
        : 10;

      const vector: FeatureVector = {
        tokenId: item.tokenMint,
        timestampMs: Date.now(),
        timeframe: '5m',
        priceUsd: market.priceUsd,
        // GRADUATION LANE (2026-09-30): lets the entry engine observe this
        // token for MOMENTUM_CONTINUATION regardless of composite score.
        isFreshGraduate: item.isFreshGraduate === true,
        return1m,
        return5m: ret5m,        // Honest 15m: tape-measured when mature, otherwise unknown (undefined).
        // Never synthesized from shorter timeframes.
        return15m: tape.return15mPct ?? undefined,
        realizedVol,
        atrPct,
        breakoutDistancePct: Math.max(0, ret5m - 2.0),
        drawdownFromPeakPct,
        upperWickRatio,
        volume5mUsd,
        volumeAcceleration,
        buySellRatio,
        flowImbalance,
        tradeCount5m: Math.max(1, tradeCount5m),
        avgTradeSizeUsd,
        liquidityUsd: market.liquidityUsd,
        estimatedPriceImpactPct,
        netBuyFlowSolEst,
        buyPressureScore,
        // Coarse heuristic from the safety gate: 10 = passed, 60 = failed.
        // Undefined is NOT used here because the gate always ran above.
        cabalClusterRiskScore: safety.isSafe ? 10 : 60,
        regime: realizedVol >= 10.0 ? 'HIGH_VOLATILITY' : (ret5m > 3.0 ? 'TRENDING_UP' : (ret5m < -5.0 ? 'PANIC' : 'RANGE')),
        quality: 'VALID'
      };

      const scoreResult = opportunityScorer.scoreOpportunity(vector, signals);
      const entryDecision = entryEngine.evaluateEntryTiming(vector, signals);

      // 1. Pucuk & Exhaustion Filter (Anti-Late Distribution & Anti-FOMO Spike)
      let isExhausted = false;
      let exhaustionReason = '';
      if (upperWickRatio !== undefined && upperWickRatio > 0.40) {
        isExhausted = true;
        exhaustionReason = `UPPER_WICK_REJECTION (Jarum atas ${(upperWickRatio * 100).toFixed(0)}% > 40% dari body - dev/insider distribusi)`;
      } else if (!ret1hKnown) {
        // m13 (2026-09-29): veto FAILS CLOSED. The old `ret1h ?? 0` let the
        // exhaustion veto never fire on unknown 1h momentum (fail-open) — an
        // unmeasurable 1h window cannot prove the token isn't post-pump.
        isExhausted = true;
        exhaustionReason = `POST_PUMP_EXHAUSTION_UNKNOWN (momentum 1j tak terukur — veto fail-closed, bukan diasumsikan sehat)`;
      } else if (ret1h > 70.0 && ret5m < 0) {
        isExhausted = true;
        exhaustionReason = `POST_PUMP_EXHAUSTION (1h +${ret1h.toFixed(0)}% with 5m rolling down ${ret5m.toFixed(1)}%)`;
      } else if (ret5m > 30.0) {
        isExhausted = true;
        exhaustionReason = `PARABOLIC_FOMO_SPIKE (+${ret5m.toFixed(1)}% 5m candle without base)`;
      }

      // 2. Smart Decision Re-Entry Guard (Only allows profitable Wave Continuation)
      let isReEntryRejected = false;
      let reEntryRejectReason = '';
      const lastClosed = getLastClosedPosition(item.tokenMint);
      if (lastClosed && lastClosed.closed_at) {
        const msSinceClose = Date.now() - new Date(lastClosed.closed_at).getTime();
        const minsSinceClose = msSinceClose / 60000;

        if (lastClosed.pnl_pct <= 0 || (lastClosed.close_reason && (lastClosed.close_reason.includes('SL') || lastClosed.close_reason.includes('DUMP')))) {
          // Rule A: Previous Loss -> Strict 24-Hour Quarantine (1440m) (never catch a falling knife)
          if (minsSinceClose < 1440) {
            isReEntryRejected = true;
            reEntryRejectReason = `RE_ENTRY_LOSS_COOLDOWN (Closed at ${lastClosed.pnl_pct.toFixed(1)}% ${minsSinceClose.toFixed(0)}m ago < 1440m / 24h quarantine)`;
          }
        } else {
          // Rule B: Previous Win -> Smart Decision Re-Entry
          // Must rest at least 10m to avoid post-exit churn
          if (minsSinceClose < 10) {
            isReEntryRejected = true;
            reEntryRejectReason = `RE_ENTRY_CHURN_GUARD (Exited in profit just ${minsSinceClose.toFixed(0)}m ago < 10m)`;
          } else {
            const prevPeak = lastClosed.peak_price_usd || lastClosed.entry_price_usd;
            const isNewHighBreakout = market.priceUsd >= prevPeak * 0.98;
            const hasStrongFlow =
              (buySellRatio !== undefined ? buySellRatio >= 1.8 : flowImbalance >= 0.6) &&
              (volumeAcceleration !== undefined && volumeAcceleration >= 1.4);

            if (!isNewHighBreakout) {
              isReEntryRejected = true;
              reEntryRejectReason = `RE_ENTRY_BELOW_PEAK (Price $${market.priceUsd.toFixed(6)} < Prev Peak $${prevPeak.toFixed(6)} - catching dump)`;
            } else if (!hasStrongFlow) {
              isReEntryRejected = true;
              reEntryRejectReason = `RE_ENTRY_WEAK_FLOW (Buy/Sell ratio ${buySellRatio?.toFixed(1) ?? 'unknown'} < 1.8 for re-entry)`;
            } else {
              console.log(`[AlgoScanner] 🌊 APPROVED SMART RE-ENTRY WAVE for ${market.symbol}! (Prev Win: +${lastClosed.pnl_pct.toFixed(1)}%, New High Confirmed: $${market.priceUsd.toFixed(6)} >= $${prevPeak.toFixed(6)})`);
            }
          }
        }
      }

      const dynamicMinScore = adaptiveLearningEngine.getMinEntryScore();
      // GRADUATION LANE (2026-09-30): a fresh graduate with a CONFIRMED
      // momentum-continuation setup (3 higher-high pushes, each with rising
      // volume + dominant flow) bypasses the composite-score gate — the
      // 3-confirmation proof IS the conviction, and thin-tape graduates
      // rarely reach 75 anyway. This is NOT a hurdle cut for the standard
      // lane: funnel (liq >= $15k, safety gate), exhaustion, re-entry and
      // quarantine checks all still apply, and entry fires at half size.
      const isGradLanePass = item.isFreshGraduate === true
        && entryDecision.shouldEnter
        && entryDecision.entryMode === 'MOMENTUM_CONTINUATION';
      let isPassed = funnelEval.passed && entryDecision.shouldEnter
        && (isGradLanePass || scoreResult.compositeScore >= dynamicMinScore);
      
      let rejectReason: string | undefined = undefined;
      if (!funnelEval.passed) {
        rejectReason = funnelEval.reason;
      } else if (!entryDecision.shouldEnter) {
        rejectReason = entryDecision.reason;
      } else if (isExhausted) {
        isPassed = false;
        rejectReason = exhaustionReason;
      } else if (isReEntryRejected) {
        isPassed = false;
        rejectReason = reEntryRejectReason;
      }

      // Tactical Classification
      let category: 'BUY_READY' | 'PULLBACK_WATCH' | 'DISCARDED' = 'DISCARDED';

      if (isPassed) {
        category = 'BUY_READY';
      } else if (funnelEval.passed && (scoreResult.compositeScore >= 45 || ret5m > 3.0 || ret1h > 5.0)) {
        category = 'PULLBACK_WATCH';
        // Auto-enroll promising runner into Helius WebSocket watchlist for real-time dip sniping
        addTokenToWatchlist(item.tokenMint, market.symbol, market.name, market.pairAddress, scoreResult.compositeScore).catch(() => {});
      } else {
        category = 'DISCARDED';
      }

      // M4: journaled below; the decisionId links the fill/rejection outcome.
      let decisionId: string | undefined = undefined;

      results.push({
        mint: item.tokenMint,
        symbol: market.symbol,
        name: market.name,
        priceUsd: market.priceUsd,
        liquidityUsd: market.liquidityUsd,
        marketCapUsd: market.marketCap,
        score: scoreResult.compositeScore,
        passed: isPassed,
        rejectReason: isPassed ? undefined : rejectReason,
        explanation: scoreResult.explanation,
        category,
        ret5m,
        ret1h,
        buys5m,
        sells5m,
        volume5mUsd,
        regime: vector.regime,
        entryMode: entryDecision.entryMode,
        discoverySource: item.source,
        gradLane: isGradLanePass === true,
        decisionId
      });

      // INSTITUTIONAL DECISION LOG (M4, 2026-09-29): every evaluated candidate
      // is persisted as EVALUATED with its PASS/SKIP verdict — NEVER as
      // EXECUTED. The old code wrote EXECUTED at verdict time for every passed
      // candidate (even though only qualifying[0] is ever bought, and any veto
      // after the verdict never updated the label), contaminating the dataset
      // used to fit scorer weights with fills that never happened. EXECUTED is
      // written only by executeBuyToken after a real fill (keyed by
      // decisionId); FAILED when the buy is rejected or fails.
      try {
        const journal = new DecisionJournal(getStorageRepository());
        const rec = await journal.logCandidateDecision({
          tokenId: item.tokenMint,
          tokenSymbol: market.symbol || 'UNKNOWN',
          decision: 'EVALUATED',
          verdict: isPassed ? 'PASS' : 'SKIP',
          compositeScore: scoreResult.compositeScore,
          rejectionReasons: isPassed ? ['VERDICT_PASS_AWAITING_FILL'] : [rejectReason || 'UNKNOWN'],
          featuresSnapshot: vector,
          regime: vector.regime,
          strategyName: signals.map(s => s.strategyName).join('+') || 'NONE',
          discoverySource: item.source
        });
        decisionId = rec.decisionId;
      } catch {}
    } catch (err: any) {
      // Continue next token
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Autonomous Background Loop: Scans and auto-buys high-scoring tokens when ALGO_ONLY or HYBRID is active
 */
let isScanCycleRunning = false;
export async function runAlgoScanCycle() {
  // m19 (2026-09-29): no overlapping scan cycles. Two overlapping cycles could
  // pass the balance check TOCTOU and double-allocate (the order lock is only
  // per-token); the 50% heat cap bounds the damage but the design gap stays.
  if (isScanCycleRunning) {
    console.log('[AlgoScanner] ⏭️ Siklus scan sebelumnya masih berjalan — lewati (anti-overlap).');
    return;
  }
  isScanCycleRunning = true;
  try {
    // O-10 (2026-09-29): autonomy kill-switch. With TELEGRAM_ADMIN_ID=0 there
    // is zero human oversight (no alerts, no /kick), so index.ts disables
    // autonomy fail-closed — the whole autonomous cycle is skipped loudly.
    if (!isAutonomousBuyEnabled()) {
      console.log(`[AlgoScanner] 🛑 AUTONOMOUS BUY MATI (fail-closed): ${getAutonomyDisableReason()} — siklus scan dilewati.`);
      return;
    }
    console.log(`[AlgoScanner] 🔍 Menjalankan siklus scan pasar kuantitatif otonom...`);
    const dynamicMinScore = adaptiveLearningEngine.getMinEntryScore();
    const candidates = await scanMarketOnce(6);

    // Push volatile candidates directly into MarketStreamer live WebSocket watchlist
    for (const c of candidates) {
      if (c.score >= 15) {
        addTokenToWatchlist(c.mint, c.symbol, c.name, undefined, c.score).catch(() => {});
      }
    }

    // GRADUATION LANE (2026-09-30): gradLane passes carry their own
    // conviction (3 confirmed continuation pushes); the score gate is not
    // re-applied to them here. Standard-lane bar unchanged.
    const qualifying = candidates.filter(c => c.passed && (c.gradLane === true || c.score >= dynamicMinScore));

    if (qualifying.length === 0) {
      console.log(`[AlgoScanner] ℹ️ Tidak ada token baru yang memenuhi ambang batas skor adaptif (>=${dynamicMinScore}). Menunggu siklus berikutnya.`);
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

    const dynamicSizing = getDynamicAlgoBuyAmount();
    // MOMENTUM_CONTINUATION (2026-09-29): buying a confirmed rally at the top
    // is a worse average entry than a dip — half size compensates the lower
    // expected win rate. Pullback entries keep full Kelly size.
    const isContinuation = best.entryMode === 'MOMENTUM_CONTINUATION';
    const allocatedSol = isContinuation
      ? dynamicSizing.allocatedSol * 0.5
      : dynamicSizing.allocatedSol;
    if (isContinuation) {
      console.log(`[AlgoScanner] 📈 Continuation entry: size setengah (${allocatedSol.toFixed(4)} SOL) — entry di rally terkonfirmasi`);
    }

    const balance = getPaperBalance();
    if (balance < allocatedSol + CONFIG.ESTIMATED_BUY_FEE_SOL) {
      return; // Insufficient funds
    }

    console.log(`[AlgoScanner] 🚀 GOLDEN OPPORTUNITY DETECTED: ${best.symbol} (${best.name}) Skor: ${best.score}/100 (Ambang Adaptif: >=${dynamicMinScore})!`);
    console.log(`[AlgoScanner] 💰 Dynamic Equity Sizing: ${allocatedSol} SOL (${dynamicSizing.rationale})`);
    
    // O-20 (2026-09-29): a buy must never fire while shutdown is in progress.
    // stopAlgoScanner waits for in-flight cycles, but this is the last line of
    // defense — the race window between the check and the fill is intentional.
    if (isShuttingDown) {
      const shutMsg = 'SHUTDOWN_IN_PROGRESS — buy dibatalkan (O-20)';
      console.log(`[AlgoScanner] 🛑 ${shutMsg}: ${best.symbol}`);
      if (best.decisionId) {
        try {
          await new DecisionJournal(getStorageRepository()).markDecisionOutcome({
            decisionId: best.decisionId, decision: 'FAILED', reason: shutMsg
          });
        } catch {}
      }
      return;
    }

    // Execute Autonomous Buy
    const buyResult = await executeBuyToken(
      best.mint,
      allocatedSol,
      'ALGO_AUTONOMOUS',
      undefined,
      undefined,
      undefined,
      {
        setupType: best.entryMode || (best.category === 'BUY_READY' ? 'PULLBACK_ABSORPTION' : 'MOMENTUM_RUNNER'),
        score: best.score,
        minScore: dynamicMinScore,
        regime: best.regime,
        explanation: best.explanation,
        priceChange5m: best.ret5m,
        priceChange1h: best.ret1h,
        // C3: never print an invented ratio as measured fact. Unknown → undefined.
        buySellRatio: best.sells5m > 0 ? (best.buys5m / best.sells5m) : undefined,
        volume5mUsd: best.volume5mUsd,
        buys5m: best.buys5m,
        sells5m: best.sells5m,
        // M4: link the fill/rejection back to the scanner's EVALUATED journal row.
        decisionId: best.decisionId
      }
    );
    // MOMENTUM_CONTINUATION: a filled continuation entry consumes its track so
    // the same rally can't re-fire immediately after exit. A failed buy leaves
    // the track alive — the thesis may still confirm on the next cycle.
    if (buyResult.success && best.entryMode === 'MOMENTUM_CONTINUATION') {
      markContinuationConsumed(best.mint);
    }
  } catch (err: any) {
    console.error('[AlgoScanner] Error during scan cycle:', err.message);
  } finally {
    isScanCycleRunning = false;
  }
}

export function startAlgoScanner() {
  if (isScannerRunning) return;
  isScannerRunning = true;
  isShuttingDown = false; // O-20: a fresh start clears the shutdown guard.
  console.log('[AlgoScanner] 🚀 Autonomous Hedge Fund Algo Scanner aktif (Goldilocks & Volatility Engine).');

  // Initial delayed scan
  setTimeout(() => runAlgoScanCycle(), 15000);
  scannerTimer = setInterval(() => runAlgoScanCycle(), SCAN_INTERVAL_MS);
}

export async function stopAlgoScanner(): Promise<void> {
  // O-20 (2026-09-29): the timer is cleared first so no NEW cycle starts, then
  // we wait for an IN-FLIGHT cycle to finish before reporting stopped — a buy
  // must never fire while the process is tearing down. The isShuttingDown
  // guard inside runAlgoScanCycle is the last line of defense for the race
  // window between our check and the fill.
  isShuttingDown = true;
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
  }
  const waitStart = Date.now();
  while (isScanCycleRunning && Date.now() - waitStart < 30_000) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (isScanCycleRunning) {
    console.warn('[AlgoScanner] ⚠️ Siklus scan masih berjalan setelah 30s — lanjut shutdown (buy diblokir via isShuttingDown).');
  }
  isScannerRunning = false;
  console.log('[AlgoScanner] 🛑 Algo Scanner dinonaktifkan.');
}
