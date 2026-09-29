import WS from 'ws';
import { getProxyAgent } from '../utils/netProxy';

// Proxy-aware WebSocket factory: in egress-proxy environments the raw `ws`
// handshake dies with EPROTO, so tunnel through the proxy when configured.
// (The Helius WS inside @solana/web3.js is covered separately by the
// require.cache patch in utils/netProxy, which must be imported first in index.ts.)
function createWebSocket(address: string, protocols?: any, options?: any): WS {
  const agent = getProxyAgent();
  return new WS(address, protocols, agent ? { agent, ...(options || {}) } : options);
}
type WebSocket = WS;
import { PublicKey } from '../utils/solanaWeb3';
import { getDedicatedConnection } from './solanaConnection';
import { getBondingCurveAddress, decodeBondingCurveBuffer } from './bondingCurve';
import { getSolPriceUsd, getTokenMarketData, getMultiTokenMarketData } from './dexscreener';
import { getOpenPositionByToken, getOpenPositions, getLastClosedPosition } from '../db/index';
import { entryEngine } from '../execution';
import { adaptiveLearningEngine } from '../strategies/adaptiveLearningEngine';
import { getOrganicTrendingTokens } from './algoScanner';
import { FeatureVector, StrategySignal } from '../core/types';
import { CONFIG } from '../config';
import { tokenTape } from '../market/tokenTape';

export interface WatchedCandidate {
  tokenMint: string;
  symbol: string;
  poolName: string;
  pairAddress?: string;
  isPump: boolean;
  bondingCurvePda?: string;
  subscriptionId?: number;
  lastSpotPriceSol: number;
  lastPriceUsd: number;
  lastLiquidityUsd: number;
  score: number;
  addedAt: number;
  lastTickAt: number;
  tickCount: number;
  priceHistory: Array<{ timestamp: number; priceUsd: number; solLiquidity: number }>;
}

const MAX_WATCHLIST_SIZE = 20; // Trimmed 2026-09-29: 50 WS subs burned Helius credits 24/7 with zero entries to show for it. Top-20 by score still covers every 75+ candidate + continuation tracking.
const TICK_HISTORY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes rolling window
const INACTIVE_PURGE_MS = 8 * 60 * 1000; // Purge if no tick for 8 minutes

/**
 * Helius onAccountChange subscription liveness guard.
 *
 * The web3.js RpcWebSocketClient auto-reconnects the socket, but a dead or
 * silently-dropped subscription (server-side expiry, key revocation, or a
 * subscription that never made it onto the re-established socket) leaves the
 * tracker in the watchlist with NO ticks and NO error — the watchlist just
 * goes blind. This timer detects that and re-subscribes with backoff.
 */
const WS_HEALTH_CHECK_INTERVAL_MS = 30_000;
/** Reconnect backoff: 2s -> 4s -> 8s -> 16s -> 30s (cap). */
const WS_RECONNECT_MIN_BACKOFF_MS = 2_000;
const WS_RECONNECT_MAX_BACKOFF_MS = 30_000;
/** A subscription with no tick for this long is treated as dead. */
const WS_DEAD_SUBSCRIPTION_MS = 90_000;

const watchlist: Map<string, WatchedCandidate> = new Map();
const wsConnection = getDedicatedConnection('POSITION_MANAGER');
let wsHealthCheckTimer: NodeJS.Timeout | null = null;
// Cached SOL/USD, refreshed whenever the curve handler fetches a fresh quote.
// Seed 180 is only a pre-first-fetch fallback, documented at use sites.
let cachedSolPriceUsd = 180;
/** Per-mint reconnect state. */
interface WsReconnectState {
  backoffMs: number;
  lastAttemptAt: number;
  /** Consecutive re-subscribe attempts that produced no new tick. */
  failCount: number;
  /** lastTickAt observed at the previous attempt (to detect zero progress). */
  lastTickAtSeen: number;
  /** Logged the give-up warning already? */
  gaveUpLogged: boolean;
}
/**
 * NET-RESILIENCE (2026-09-29): after this many consecutive re-subscribes with
 * zero new ticks, stop WS attempts for that mint — the endpoint/network is
 * down, churning only leaks resources. The Raydium batch syncer still covers
 * price data. Reset automatically when ticks resume (health check deletes
 * state for healthy mints).
 */
const WS_MAX_CONSECUTIVE_RESUB_FAILS = 15;
const wsReconnectState: Map<string, WsReconnectState> = new Map();

let isStreamerRunning = false;
let pumpportalWs: WebSocket | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let raydiumBatchTimer: NodeJS.Timeout | null = null;
let evaluateCooldown: Map<string, number> = new Map();

type TelegramNotifier = (message: string, extra?: any) => Promise<void>;
let streamerNotifier: TelegramNotifier | null = null;

export function setMarketStreamerNotifier(notifier: TelegramNotifier) {
  streamerNotifier = notifier;
}

async function notify(msg: string, extra?: any) {
  if (streamerNotifier) {
    try {
      await streamerNotifier(msg, extra);
    } catch {}
  }
}

/**
 * Intelligent Eviction Policy:
 * 1. Tokens without ticks for >8m are evicted first.
 * 2. Tokens that suffered catastrophic dump (>15% drawdown) are evicted second.
 * 3. High-conviction setups in the pullback zone are protected!
 */
function evictLowestPriorityToken() {
  if (watchlist.size < MAX_WATCHLIST_SIZE) return;

  const now = Date.now();
  let candidateToEvict: string | null = null;
  let highestEvictionScore = -1;

  for (const [mint, item] of watchlist.entries()) {
    const inactiveMs = now - item.lastTickAt;
    let evictionPriority = 0;

    if (inactiveMs > INACTIVE_PURGE_MS) {
      evictionPriority = 1000 + (inactiveMs / 1000);
    } else {
      let peakPrice = 0;
      for (const h of item.priceHistory) {
        if (h.priceUsd > peakPrice) peakPrice = h.priceUsd;
      }
      const dd = peakPrice > 0 ? ((peakPrice - item.lastPriceUsd) / peakPrice) * 100 : 0;
      if (dd > 15.0) {
        evictionPriority = 500 + dd;
      } else {
        const ageMin = (now - item.addedAt) / 60000;
        evictionPriority = Math.max(0, 100 - (item.score || 50)) + (ageMin * 2);
      }
    }

    if (evictionPriority > highestEvictionScore) {
      highestEvictionScore = evictionPriority;
      candidateToEvict = mint;
    }
  }

  if (candidateToEvict) {
    removeTokenFromWatchlist(candidateToEvict);
  }
}

/**
 * (Re)subscribes a watchlist candidate's Helius onAccountChange tracker.
 * Extracted from addTokenToWatchlist so the health-check below can re-establish
 * a dead subscription without touching watchlist bookkeeping.
 *
 * Returns the new subscription id, or `undefined` if the candidate has no
 * subscribable on-chain account.
 */
function resubscribeCandidate(item: WatchedCandidate): number | undefined {
  if (item.isPump) {
    const pdaPubkey = getBondingCurveAddress(item.tokenMint);
    item.bondingCurvePda = pdaPubkey.toBase58();
    return wsConnection.onAccountChange(
      pdaPubkey,
      (accountInfo) => {
        handleOnChainCurveUpdate(item.tokenMint, accountInfo.data);
      },
      'confirmed'
    );
  }

  if (item.pairAddress && item.pairAddress.length >= 32) {
    // Raydium / DEX AMM On-Chain Subscription
    const poolPubkey = new PublicKey(item.pairAddress);
    return wsConnection.onAccountChange(
      poolPubkey,
      (accountInfo) => {
        handleRaydiumPoolUpdate(item.tokenMint, accountInfo.data);
      },
      'confirmed'
    );
  }

  return undefined;
}

/**
 * Detects and repairs dead Helius account-change subscriptions.
 *
 * A subscription that has produced no ticks for WS_DEAD_SUBSCRIPTION_MS while
 * the watchlist item is still considered live is treated as silently dropped
 * (the underlying socket may have reconnected without re-establishing it, or
 * Helius expired it). We unsubscribe the stale id and re-subscribe, retrying
 * with exponential backoff (2s -> 30s cap) so a persistently down endpoint is
 * not hammered.
 */
function checkHeliusSubscriptionHealth(): void {
  if (!isStreamerRunning) return;

  const now = Date.now();
  for (const [mint, item] of watchlist.entries()) {
    if (item.subscriptionId === undefined) continue;

    const silenceMs = now - item.lastTickAt;
    if (silenceMs < WS_DEAD_SUBSCRIPTION_MS) {
      // Healthy (or at least not provably dead) — reset its backoff.
      wsReconnectState.delete(mint);
      continue;
    }

    // Guard: don't retry faster than the exponential backoff allows.
    const state = wsReconnectState.get(mint) ?? {
      backoffMs: WS_RECONNECT_MIN_BACKOFF_MS,
      lastAttemptAt: 0,
      failCount: 0,
      lastTickAtSeen: item.lastTickAt,
      gaveUpLogged: false,
    };
    if (now - state.lastAttemptAt < state.backoffMs) continue;

    // NET-RESILIENCE: no tick since the previous attempt => this attempt
    // (if we make it) starts from zero progress. Give up WS for this mint
    // after too many consecutive fruitless attempts.
    if (item.lastTickAt === state.lastTickAtSeen) {
      state.failCount++;
    } else {
      state.failCount = 0;
      state.lastTickAtSeen = item.lastTickAt;
    }
    if (state.failCount >= WS_MAX_CONSECUTIVE_RESUB_FAILS) {
      if (!state.gaveUpLogged) {
        state.gaveUpLogged = true;
        console.warn(
          `[MarketStreamer] 🛑 ${item.symbol}: ${state.failCount}x re-subscribe tanpa tick baru — hentikan percobaan WS (batch syncer tetap cover).`
        );
      }
      wsReconnectState.set(mint, state);
      continue;
    }

    console.warn(`[MarketStreamer] 📡 Helius subscription for ${item.symbol} silent for ${Math.round(silenceMs / 1000)}s. Re-subscribing (backoff ${Math.round(state.backoffMs / 1000)}s)...`);
    state.lastAttemptAt = now;
    // Next retry waits twice as long, capped at 30s.
    state.backoffMs = Math.min(WS_RECONNECT_MAX_BACKOFF_MS, state.backoffMs * 2);
    wsReconnectState.set(mint, state);

    try {
      // removeAccountChangeListener is async; fire-and-forget the stale id.
      wsConnection.removeAccountChangeListener(item.subscriptionId).catch(() => {});
    } catch {}

    try {
      const newSubId = resubscribeCandidate(item);
      if (newSubId !== undefined) {
        item.subscriptionId = newSubId;
        console.log(`[MarketStreamer] ♻️ Re-subscribed ${item.symbol} (new sub #${newSubId}).`);
      } else {
        // No subscribable account — leave it; the Raydium batch syncer covers it.
        wsReconnectState.delete(mint);
      }
    } catch (err: any) {
      console.warn(`[MarketStreamer] Re-subscribe failed for ${item.symbol}: ${err.message}`);
    }
  }
}

/**
 * Adds a candidate token to the real-time WebSocket watchlist.
 * Supports both Pump.fun bonding curves AND Raydium AMM pools.
 */
export async function addTokenToWatchlist(
  tokenMint: string,
  symbol: string,
  poolName: string = '',
  pairAddress: string = '',
  score: number = 50
): Promise<boolean> {
  if (watchlist.has(tokenMint)) {
    const existing = watchlist.get(tokenMint)!;
    if (score > (existing.score || 0)) existing.score = score;
    if (pairAddress && !existing.pairAddress) existing.pairAddress = pairAddress;
    return true;
  }

  if (watchlist.size >= MAX_WATCHLIST_SIZE) {
    evictLowestPriorityToken();
  }

  const isPump = tokenMint.endsWith('pump');
  let bondingCurvePda: string | undefined = undefined;
  let subId: number | undefined = undefined;

  try {
    if (isPump) {
      bondingCurvePda = getBondingCurveAddress(tokenMint).toBase58();
    }

    const candidate: WatchedCandidate = {
      tokenMint,
      symbol,
      poolName: poolName || symbol,
      pairAddress,
      isPump,
      bondingCurvePda,
      subscriptionId: undefined,
      lastSpotPriceSol: 0,
      lastPriceUsd: 0,
      lastLiquidityUsd: 0,
      score,
      addedAt: Date.now(),
      lastTickAt: Date.now(),
      tickCount: 0,
      priceHistory: []
    };

    subId = resubscribeCandidate(candidate);
    candidate.subscriptionId = subId;

    watchlist.set(tokenMint, candidate);
    wsReconnectState.delete(tokenMint);

    console.log(`[MarketStreamer] ⚡ Live WebSocket tracker aktif untuk: ${symbol} (${tokenMint.slice(0, 8)}...) [Watchlist: ${watchlist.size}/${MAX_WATCHLIST_SIZE}]`);
    return true;
  } catch (err: any) {
    console.warn(`[MarketStreamer] Gagal subscribe WebSocket untuk ${symbol}:`, err.message);
    return false;
  }
}

/**
 * Unsubscribes and cleans a token from the watchlist
 */
export function removeTokenFromWatchlist(tokenMint: string) {
  const item = watchlist.get(tokenMint);
  if (!item) return;

  if (item.subscriptionId !== undefined) {
    try {
      wsConnection.removeAccountChangeListener(item.subscriptionId);
    } catch {}
  }
  watchlist.delete(tokenMint);
  evaluateCooldown.delete(tokenMint);
  wsReconnectState.delete(tokenMint);
  console.log(`[MarketStreamer] 🛑 Watchlist unsubscribed: ${item.symbol} (${tokenMint.slice(0, 8)}...)`);
}

/**
 * Event-Driven onAccountChange Handler:
 * Decodes 81-byte bonding curve account buffer in <0.16ms on CPU.
 * Zero HTTP requests!
 */
async function handleOnChainCurveUpdate(tokenMint: string, data: Buffer) {
  const item = watchlist.get(tokenMint);
  if (!item) return;

  const now = Date.now();
  item.lastTickAt = now;
  item.tickCount++;

  const state = decodeBondingCurveBuffer(data);
  if (!state || state.spotPriceSol <= 0) return;

  const solPriceUsd = await getSolPriceUsd();
  if (solPriceUsd > 0) cachedSolPriceUsd = solPriceUsd;
  const currentPriceUsd = state.spotPriceSol * solPriceUsd;
  const currentLiquidityUsd = state.liquiditySol * solPriceUsd;

  item.lastSpotPriceSol = state.spotPriceSol;
  item.lastPriceUsd = currentPriceUsd;
  item.lastLiquidityUsd = currentLiquidityUsd;

  // Append tick to rolling history
  item.priceHistory.push({
    timestamp: now,
    priceUsd: currentPriceUsd,
    solLiquidity: state.liquiditySol
  });

  // Feed the shared institutional tape (tick-resolution price discovery;
  // volume unknown on bonding-curve ticks — recorded as 0 and skipped by
  // the tape's interval-volume computation).
  tokenTape.record(tokenMint, currentPriceUsd, 0, currentLiquidityUsd);

  // Prune history older than 5 minutes
  const cutoff = now - TICK_HISTORY_WINDOW_MS;
  while (item.priceHistory.length > 0 && item.priceHistory[0].timestamp < cutoff) {
    item.priceHistory.shift();
  }

  // Check if token graduated to Raydium
  if (state.complete) {
    console.log(`[MarketStreamer] 🎓 Token GRADUATED to Raydium: ${item.symbol}! Migrating tracker...`);
  }

  // Trigger real-time opportunity evaluation
  await evaluateWatchlistCandidateOnTick(item, state);
}

/**
 * Event-Driven onAccountChange Handler for Raydium / AMM Pools:
 * Fires instantly whenever a swap changes pool state on-chain.
 */
async function handleRaydiumPoolUpdate(tokenMint: string, data: Buffer) {
  const item = watchlist.get(tokenMint);
  if (!item) return;

  const now = Date.now();
  item.lastTickAt = now;
  item.tickCount++;

  // Throttled fast market data refresh for Raydium pools (at most once every 3s)
  const lastEval = evaluateCooldown.get(tokenMint) || 0;
  if (now - lastEval >= 3000) {
    evaluateCooldown.set(tokenMint, now);
    try {
      const market = await getTokenMarketData(tokenMint);
      if (market && market.priceUsd > 0) {
        item.lastPriceUsd = market.priceUsd;
        item.lastLiquidityUsd = market.liquidityUsd;
        item.priceHistory.push({
          timestamp: now,
          priceUsd: market.priceUsd,
          // O-19: never divide by a hardcoded SOL price again — use the
          // cached live price (falls back to 180 only if never observed).
          solLiquidity: market.liquidityUsd / (cachedSolPriceUsd > 0 ? cachedSolPriceUsd : 180)
        });

        const cutoff = now - TICK_HISTORY_WINDOW_MS;
        while (item.priceHistory.length > 0 && item.priceHistory[0].timestamp < cutoff) {
          item.priceHistory.shift();
        }

        // O-19: { complete: true } already skips curve-progress gating, so
        // pass NO fabricated realSolReserves (the old 85*1e9 = "100% curve"
        // was invented data that only looked measured).
        await evaluateWatchlistCandidateOnTick(item, { complete: true });
      }
    } catch {}
  }
}

/**
 * Real-Time Quantitative Evaluation on Live WebSocket Price Ticks
 */
async function evaluateWatchlistCandidateOnTick(item: WatchedCandidate, curveState: any) {
  const now = Date.now();
  const lastEval = evaluateCooldown.get(item.tokenMint) || 0;
  // Rate limiter: evaluate at most once per 6 seconds per token
  if (now - lastEval < 6000) return;
  evaluateCooldown.set(item.tokenMint, now);

  // If we already have an open position on this token, skip entry evaluation
  const existing = getOpenPositionByToken(item.tokenMint);
  if (existing) return;

  // Need at least 2 ticks to compute short-term momentum
  if (item.priceHistory.length < 2) return;

  const oldest = item.priceHistory[0];
  const latest = item.priceHistory[item.priceHistory.length - 1];
  const priceChangePct = oldest.priceUsd > 0 ? ((latest.priceUsd - oldest.priceUsd) / oldest.priceUsd) * 100 : 0;

  // Only consider tokens with positive price acceleration
  if (priceChangePct < 2.0) return;

  // Check bonding curve progress (Sweet spot: 20% - 90%)
  // O-19: realSolReserves may be absent for migrated (Raydium) pools — NaN
  // fails every comparison below, so an unknown curve never rejects a token
  // on fabricated data. complete=true pools skip this gate entirely.
  const realSol = curveState.realSolReserves != null ? Number(curveState.realSolReserves) / 1e9 : NaN;
  const curveProgressPct = Math.min(100, Math.max(0, (realSol / 85.0) * 100));
  if (!curveState.complete && (curveProgressPct < 15.0 || curveProgressPct > 92.0)) {
    return;
  }

  // Compute Peak Price & Drawdown in rolling window for Absorption verification
  let peakPriceUsd = 0;
  for (const p of item.priceHistory) {
    if (p.priceUsd > peakPriceUsd) peakPriceUsd = p.priceUsd;
  }
  const drawdownFromPeakPct = peakPriceUsd > 0 ? Math.max(0, ((peakPriceUsd - latest.priceUsd) / peakPriceUsd) * 100) : 0;

  // Pucuk Guard: Upper Wick Rejection (> 40% of candle body)
  // Honest version (2026-09-29): when the body is unmeasurable the ratio is
  // unknown (undefined), never the old 999.0 sentinel that forced rejection
  // on fabricated data. The guard skips when unknown.
  const openPrice = oldest.priceUsd;
  const currentPrice = latest.priceUsd;
  const candleBody = Math.max(0, currentPrice - openPrice);
  const upperWick = Math.max(0, peakPriceUsd - currentPrice);
  const upperWickRatio = candleBody > 0 ? (upperWick / candleBody) : undefined;

  if (upperWickRatio !== undefined && upperWickRatio > 0.40) {
    console.log(`[MarketStreamer] 🛑 REJECTED: UPPER_WICK_REJECTION for ${item.symbol}: Jarum atas ${(upperWickRatio * 100).toFixed(0)}% > 40% dari body (Peak: $${peakPriceUsd.toFixed(6)} -> Current: $${currentPrice.toFixed(6)})`);
    return;
  }

  // Compute 1m return (checks if latest tick is green rebound or dropping)
  const oneMinAgo = now - 60000;
  const tick1mAgo = item.priceHistory.find(p => p.timestamp >= oneMinAgo) || oldest;
  const return1m = tick1mAgo.priceUsd > 0 ? ((latest.priceUsd - tick1mAgo.priceUsd) / tick1mAgo.priceUsd) * 100 : 0;

  // Fetch live market data for genuine microstructure order flow (Eliminates synthetic fake breakout traps!)
  let realMarketData: any = null;
  try {
    realMarketData = await getTokenMarketData(item.tokenMint);
  } catch {}

  // Fail-Safe Gate: Do not trade blindly if market data is unavailable due to rate limits or network issues!
  if (!realMarketData || !realMarketData.priceUsd) {
    return;
  }

  const liquidityUsd = realMarketData.liquidityUsd || item.lastLiquidityUsd || 0;
  const realVol5mUsd = realMarketData.volume5m || 0;
  // C4 FIX (2026-09-29): dropped the `volume24h/24` linear-extrapolation fabrication.
  // When the 1h baseline is missing, rvol5m falls back to the REAL tick-velocity
  // proxy below — never a synthesized baseline.
  const vol1hUsd: number | undefined = realMarketData.volume1h;
  const volume24hUsd = realMarketData.volume24h || 0;
  const txnsUnknown = realMarketData.txns5mBuys === undefined || realMarketData.txns5mSells === undefined;
  const buys5m = realMarketData.txns5mBuys ?? 0;
  const sells5m = realMarketData.txns5mSells ?? 0;
  const tradeCount5m = buys5m + sells5m;

  // 1. INSTITUTIONAL LIQUIDITY FLOOR: Reject pools with < $25,000 liquidity (Prevents slippage death & micro-cap rugs)
  const minLiq = CONFIG.MIN_LIQUIDITY_USD || 25000;
  if (liquidityUsd < minLiq) {
    return;
  }

  // 2. ACTIVE MARKET PARTICIPATION: Reject dead pools (< 8 trades in 5m or < $15k 5m volume)
  if (tradeCount5m < 8 || (realVol5mUsd < 15000 && volume24hUsd < 50000)) {
    return;
  }

  // 3. ORDER FLOW DOMINANCE: Must have genuine buy dominance with sufficient trade count.
  // C3 FIX (2026-09-29): ONE honest rule — the old code invented 2.5 here when
  // sells==0 (3.0 on the scanner path, 2.0 in the Telegram reason), tuned to PASS
  // this gate. Now the ratio is UNDEFINED on zero-sell/unknown and the dominance
  // question is answered by flowImbalance (honest) instead of an invented number.
  const realBuySellRatio: number | undefined = (!txnsUnknown && sells5m > 0) ? (buys5m / sells5m) : undefined;
  const realFlowImbalance = tradeCount5m > 0 ? (buys5m - sells5m) / tradeCount5m : 0;
  if (realBuySellRatio === undefined ? realFlowImbalance < 0.5 : realBuySellRatio < 1.35) {
    return;
  }

  // 4. REAL DYNAMIC PRICE IMPACT: Never enter if our order causes > 1.5% pool impact.
  // M2 FIX (2026-09-29): use the live cached SOL price, not a stale $180 literal.
  const buyAmountUsd = (CONFIG.DEFAULT_BUY_AMOUNT_SOL || 0.05) * cachedSolPriceUsd;
  const estImpactPct = liquidityUsd > 0 ? (buyAmountUsd / (liquidityUsd * 0.5)) * 100 : 99;
  if (estImpactPct > 1.5) {
    return;
  }

  const tickVelocity = item.tickCount;
  // (realFlowImbalance declared once above at gate 3 — C3 fix.)
  const rvol5m = vol1hUsd !== undefined && vol1hUsd > 0 ? Math.min(10.0, Math.max(1.0, (realVol5mUsd * 12) / vol1hUsd)) : Math.min(10.0, Math.max(1.0, tickVelocity / 4.0));
  const effectiveRet5m = realMarketData.priceChange5m ?? priceChangePct;
  const realizedVol = Math.max(4.0, Math.abs(effectiveRet5m) * 1.3);

  // Honest buy-pressure estimation (2026-09-29): derived from the real
  // aggregate buy/sell counts in this 5m window. Not whale-wallet tracking.
  const avgTradeSizeUsd = tradeCount5m > 0 ? realVol5mUsd / tradeCount5m : 80;
  // C3: flow estimates from MEASURED dominance only — never an invented ratio.
  const wsNetBuyFlowSolEst = (realBuySellRatio !== undefined && realBuySellRatio >= 1.5)
    ? Math.round(Math.max(0, buys5m - sells5m) * (avgTradeSizeUsd / cachedSolPriceUsd) * 10) / 10
    : undefined;
  const wsBuyPressureScore = tradeCount5m >= 8
    ? (realBuySellRatio !== undefined
        ? (realBuySellRatio >= 1.8 ? 90 : (realBuySellRatio >= 1.3 ? 75 : 45))
        : (realFlowImbalance >= 0.6 ? 90 : (realFlowImbalance >= 0.3 ? 75 : 45)))
    : undefined;
  const wsTape = tokenTape.getFeatures(item.tokenMint);

  // Build Feature Vector from REAL on-chain/AMM data
  const vector: FeatureVector = {
    tokenId: item.tokenMint,
    timestampMs: now,
    timeframe: '5m',
    priceUsd: currentPrice,
    return1m,
    return5m: effectiveRet5m,
    // Honest 15m: tape-measured when mature, else unknown. Never synthesized.
    return15m: wsTape.return15mPct ?? undefined,
    realizedVol,
    atrPct: Math.max(3.5, realizedVol * 1.2),
    breakoutDistancePct: Math.max(0, effectiveRet5m - 2.0),
    drawdownFromPeakPct,
    upperWickRatio,
    volume5mUsd: realVol5mUsd,
    volumeAcceleration: rvol5m,
    buySellRatio: realBuySellRatio,
    flowImbalance: realFlowImbalance,
    tradeCount5m: tradeCount5m > 0 ? tradeCount5m : tickVelocity,
    avgTradeSizeUsd,
    liquidityUsd: liquidityUsd,
    estimatedPriceImpactPct: estImpactPct,
    netBuyFlowSolEst: wsNetBuyFlowSolEst,
    buyPressureScore: wsBuyPressureScore,
    // Cabal risk is NOT assessed on the WS hot path (left undefined);
    // executeBuyToken runs the full safety gate downstream before any fill.
    cabalClusterRiskScore: undefined,
    regime: realizedVol >= 10.0 ? 'HIGH_VOLATILITY' : 'TRENDING_UP',
    quality: 'VALID'
  };

  const signals: StrategySignal[] = [
    {
      signalId: `ws_mom_${item.tokenMint.slice(0, 6)}_${now}`,
      tokenId: item.tokenMint,
      tokenSymbol: item.symbol,
      strategyName: 'MOMENTUM',
      strategyVersion: '1.0',
      direction: 'BUY',
      confidence: Math.min(1.0, priceChangePct / 20.0),
      regime: 'TRENDING_UP',
      invalidationPriceUsd: item.lastPriceUsd * 0.9,
      targetTpPct: 35,
      targetSlPct: 8,
      suggestedHoldingPeriodMinutes: 15,
      featureSnapshot: {},
      generatedAt: new Date().toISOString()
    }
  ];

  // Evaluate through Entry Engine Finite State Machine
  const decision = entryEngine.evaluateEntryTiming(vector, signals);
  const minScore = adaptiveLearningEngine.getMinEntryScore();

  if (decision.shouldEnter && decision.compositeScore >= minScore) {
    // INSTITUTIONAL RISK RULE: MarketStreamer is strictly for real-time telemetry, position monitoring & watchlist streaming.
    // Raw WebSocket ticks must NEVER execute blind buys (prevents "Beli di Pucuk" / exhaustion entries which caused 85% loss rate).
    // Qualified breakout candidates are instead queued to Watchlist for AlgoScanner's rigorous multi-factor confirmation.
    console.log(`[MarketStreamer] 📡 High momentum tick detected for ${item.symbol} (Score: ${decision.compositeScore}/${minScore}). Filtered from blind WS entry; promoted to Watchlist for AlgoScanner multi-factor confirmation.`);
  }
}

/**
 * Connects to PumpPortal Real-Time Raydium Migration Stream:
 * Free, zero-API-key WebSocket listening to bonding curve completions
 */
function startPumpPortalMigrationStream() {
  if (pumpportalWs) return;

  try {
    pumpportalWs = createWebSocket('wss://pumpportal.fun/api/data');

    pumpportalWs.on('open', () => {
      console.log('[MarketStreamer] 🌐 Terhubung ke PumpPortal WebSocket. Menyimak stream migrasi Raydium live...');
      pumpportalWs?.send(JSON.stringify({ method: 'subscribeMigration' }));
    });

    pumpportalWs.on('message', async (data: any) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.txType === 'migrate' || payload.type === 'migration' || payload.event === 'migration') {
          const mint = payload.mint || payload.tokenAddress;
          const symbol = payload.symbol || 'MIGRATED';
          if (mint && !watchlist.has(mint)) {
            console.log(`[MarketStreamer] 🚀 HOT RAYDIUM MIGRATION EVENT: ${symbol} (${mint.slice(0, 8)}...) baru saja graduated ke Raydium! Menambahkan ke Watchlist...`);
            await addTokenToWatchlist(mint, symbol, 'Raydium Migration Runner');
          }
        }
      } catch {}
    });

    pumpportalWs.on('close', () => {
      pumpportalWs = null;
      if (isStreamerRunning) {
        setTimeout(startPumpPortalMigrationStream, 5000); // Reconnect
      }
    });

    pumpportalWs.on('error', () => {
      // Reconnect handled on close
    });
  } catch (err: any) {
    console.warn('[MarketStreamer] Gagal inisialisasi PumpPortal WebSocket:', err.message);
  }
}

/**
 * Refreshes candidate watchlist with the highest-volatility runners
 * (Called once at startup and passively during maintenance)
 */
export async function seedWatchlistWithVolatileRunners() {
  try {
    const candidates = await getOrganicTrendingTokens(MAX_WATCHLIST_SIZE);
    for (const c of candidates) {
      if (watchlist.size >= MAX_WATCHLIST_SIZE) break;
      await addTokenToWatchlist(c.tokenMint, c.poolName.split(' ')[0] || 'RUNNER', c.poolName, c.pairAddress);
    }
    console.log(`[MarketStreamer] ✅ Watchlist seeded dengan ${watchlist.size} token volatil runner.`);
  } catch (err: any) {
    console.warn('[MarketStreamer] Gagal seed watchlist:', err.message);
  }
}

/**
 * Starts the Zero-Polling Real-Time Event-Driven Market Streaming Engine
 */
export async function startMarketStreamer() {
  if (isStreamerRunning) return;
  isStreamerRunning = true;
  console.log('[MarketStreamer] ⚡ Zero-Polling Real-Time Market Streaming Engine aktif.');

  // 1. Start PumpPortal Migration stream
  startPumpPortalMigrationStream();

  // 2. Seed watchlist with initial volatile runners (BACKGROUND: never block startup on
  // third-party APIs — the 15s batch syncer, PumpPortal stream, and 10m scanner watchdog
  // keep the watchlist fresh regardless).
  seedWatchlistWithVolatileRunners().catch((err: any) =>
    console.warn('[MarketStreamer] Background watchlist seed failed:', err?.message));

  // 3. Fast 15s batch price syncer for Raydium / AMM tokens (1 single HTTP request for all non-pump tokens)
  raydiumBatchTimer = setInterval(async () => {
    const nonPumpMints: string[] = [];
    for (const [mint, item] of watchlist.entries()) {
      if (!item.isPump) {
        nonPumpMints.push(mint);
      }
    }
    if (nonPumpMints.length === 0) return;

    try {
      const marketMap = await getMultiTokenMarketData(nonPumpMints.slice(0, 30));
      const now = Date.now();
      for (const mint of nonPumpMints) {
        const m = marketMap.get(mint);
        const item = watchlist.get(mint);
        if (m && item && m.priceUsd > 0) {
          item.lastPriceUsd = m.priceUsd;
          item.lastLiquidityUsd = m.liquidityUsd;
          item.lastTickAt = now;
          item.tickCount++;
          item.priceHistory.push({
            timestamp: now,
            priceUsd: m.priceUsd,
            // O-19: cached live SOL price, never a hardcoded 180.
            solLiquidity: m.liquidityUsd / (cachedSolPriceUsd > 0 ? cachedSolPriceUsd : 180)
          });
          const cutoff = now - TICK_HISTORY_WINDOW_MS;
          while (item.priceHistory.length > 0 && item.priceHistory[0].timestamp < cutoff) {
            item.priceHistory.shift();
          }
          // O-19: no fabricated realSolReserves (see note above).
          await evaluateWatchlistCandidateOnTick(item, { complete: true });
        }
      }
    } catch {}
  }, 15000);

  // 4. Gentle 60s memory pruner (purges inactive tokens, keeps RAM <25MB)
  maintenanceTimer = setInterval(async () => {
    const now = Date.now();
    for (const [mint, item] of watchlist.entries()) {
      if (now - item.lastTickAt > INACTIVE_PURGE_MS) {
        console.log(`[MarketStreamer] ⌛ Token ${item.symbol} tidak aktif selama 8 menit. Purging dari memori...`);
        removeTokenFromWatchlist(mint);
      }
    }

    // If watchlist drops below 10 tokens, seed fresh volatile runners
    if (watchlist.size < 10) {
      await seedWatchlistWithVolatileRunners();
    }
  }, 60000);

  // 5. Helius WS subscription liveness guard (reconnect-with-backoff).
  // Detects silently dead onAccountChange trackers and re-subscribes them so
  // a dropped socket cannot permanently blind the watchlist.
  if (!wsHealthCheckTimer) {
    wsHealthCheckTimer = setInterval(() => {
      try {
        checkHeliusSubscriptionHealth();
      } catch (err: any) {
        // A failure in the health check itself must not kill the streamer.
        console.warn(`[MarketStreamer] WS health check error: ${err.message}`);
      }
    }, WS_HEALTH_CHECK_INTERVAL_MS);
    console.log(`[MarketStreamer] 🩺 Helius WS subscription health check aktif (every ${WS_HEALTH_CHECK_INTERVAL_MS / 1000}s).`);
  }
}

/**
 * Stops the streaming engine cleanly
 */
export function stopMarketStreamer() {
  isStreamerRunning = false;
  if (wsHealthCheckTimer) {
    clearInterval(wsHealthCheckTimer);
    wsHealthCheckTimer = null;
  }
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  if (raydiumBatchTimer) {
    clearInterval(raydiumBatchTimer);
    raydiumBatchTimer = null;
  }
  if (pumpportalWs) {
    try { pumpportalWs.close(); } catch {}
    pumpportalWs = null;
  }
  for (const mint of Array.from(watchlist.keys())) {
    removeTokenFromWatchlist(mint);
  }
  console.log('[MarketStreamer] 🛑 Market Streaming Engine dinonaktifkan.');
}

export function getWatchlistStatus(): Array<{
  mint: string;
  symbol: string;
  poolName: string;
  isPump: boolean;
  ticks: number;
  lastPriceUsd: number;
  lastLiquidityUsd: number;
  addedAt: number;
  lastTickAt: number;
  ret1m: number;
  drawdownFromPeakPct: number;
}> {
  const now = Date.now();
  return Array.from(watchlist.values()).map(w => {
    let ret1m = 0;
    let peakPrice = w.lastPriceUsd;

    if (w.priceHistory.length > 0) {
      const oneMinAgo = now - 60000;
      const tick1mAgo = w.priceHistory.find(h => h.timestamp >= oneMinAgo) || w.priceHistory[0];
      if (tick1mAgo && tick1mAgo.priceUsd > 0 && w.lastPriceUsd > 0) {
        ret1m = ((w.lastPriceUsd - tick1mAgo.priceUsd) / tick1mAgo.priceUsd) * 100;
      }
      for (const h of w.priceHistory) {
        if (h.priceUsd > peakPrice) peakPrice = h.priceUsd;
      }
    }

    const drawdownFromPeakPct = peakPrice > 0 && w.lastPriceUsd > 0
      ? ((peakPrice - w.lastPriceUsd) / peakPrice) * 100
      : 0;

    return {
      mint: w.tokenMint,
      symbol: w.symbol,
      poolName: w.poolName,
      isPump: w.isPump,
      ticks: w.tickCount,
      lastPriceUsd: w.lastPriceUsd,
      lastLiquidityUsd: w.lastLiquidityUsd,
      addedAt: w.addedAt,
      lastTickAt: w.lastTickAt,
      ret1m,
      drawdownFromPeakPct
    };
  });
}
