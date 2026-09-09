import { PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM_ID, getBondingCurveAddress, getOnChainBondingCurve } from './bondingCurve';
import { getDedicatedConnection } from './solanaConnection';

export interface DiscoveredWsToken {
  mint: string;
  bondingCurvePda: string;
  type: 'NEW_MINT' | 'BUY_FLOW';
  detectedAt: number;
  activityCount: number;
}

// In-memory cache of tokens discovered over WebSocket (max 100 tokens, 30-min TTL)
const discoveredTokens: Map<string, DiscoveredWsToken> = new Map();
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let isWsStreamActive = false;
let wsSubscriptionId: number | null = null;
let newCandidateListeners: Array<(token: DiscoveredWsToken) => void> = [];

const wsConnection = getDedicatedConnection('WHALE_TRACKER');

let lastParseTime = 0;
const PARSE_COOLDOWN_MS = 12000; // 12 seconds cooldown between RPC transaction parses

/**
 * Starts real-time WebSocket streaming of Pump.fun on-chain logs.
 * Captures token minting in real-time straight from Solana validators.
 * Zero HTTP requests needed for token discovery!
 */
export function startSolanaWsStream(): void {
  if (isWsStreamActive) return;
  isWsStreamActive = true;

  try {
    console.log('[SolanaWsStream] ⚡ Menghubungkan ke Solana Helius WebSocket untuk streaming log token real-time...');

    wsSubscriptionId = wsConnection.onLogs(
      PUMP_FUN_PROGRAM_ID,
      async (logsCtx) => {
        if (logsCtx.err) return;

        const logs = logsCtx.logs || [];
        // Only target new token mint creations (avoids hammering RPC with hundreds of buy logs!)
        const isCreate = logs.some(l => l.includes('Instruction: Create'));
        if (!isCreate) return;

        // Rate limiter: prevent blasting Helius RPC
        const now = Date.now();
        if (now - lastParseTime < PARSE_COOLDOWN_MS) return;
        lastParseTime = now;

        try {
          // Parse transaction via RPC to extract exact token mint
          const tx = await wsConnection.getParsedTransaction(logsCtx.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
          });

          if (!tx || !tx.meta || tx.meta.err) return;

          // Look for token mint in postTokenBalances
          const postBalances = tx.meta.postTokenBalances || [];
          let targetMint: string | null = null;

          for (const b of postBalances) {
            if (b.mint && b.mint !== 'So11111111111111111111111111111111111111112') {
              targetMint = b.mint;
              break;
            }
          }

          // Fallback: examine account keys if not found in token balances
          if (!targetMint && tx.transaction?.message?.accountKeys) {
            const keys = tx.transaction.message.accountKeys;
            for (const k of keys) {
              const pubkeyStr = typeof k === 'string' ? k : k.pubkey.toBase58();
              if (pubkeyStr.endsWith('pump') && pubkeyStr.length >= 32) {
                targetMint = pubkeyStr;
                break;
              }
            }
          }

          if (targetMint) {
            registerDiscoveredToken(targetMint, 'NEW_MINT');
          }
        } catch {
          // Back off gently on transient RPC rate limit
          lastParseTime = Date.now() + 20_000;
        }
      },
      'confirmed'
    );

    console.log(`[SolanaWsStream] ✅ WebSocket Stream aktif (Sub ID: ${wsSubscriptionId}). Menyimak log Pump.fun secara live.`);
  } catch (err: any) {
    console.error('[SolanaWsStream] Gagal menginisialisasi WebSocket log stream:', err.message);
    isWsStreamActive = false;
  }
}

function registerDiscoveredToken(mint: string, type: 'NEW_MINT' | 'BUY_FLOW') {
  const existing = discoveredTokens.get(mint);
  const now = Date.now();

  if (existing) {
    existing.activityCount += 1;
    existing.detectedAt = now;
  } else {
    // Evict oldest if cache limit reached
    if (discoveredTokens.size >= MAX_CACHE_SIZE) {
      const oldestKey = discoveredTokens.keys().next().value;
      if (oldestKey) discoveredTokens.delete(oldestKey);
    }

    const pda = getBondingCurveAddress(mint).toBase58();
    const item: DiscoveredWsToken = {
      mint,
      bondingCurvePda: pda,
      type,
      detectedAt: now,
      activityCount: 1
    };
    discoveredTokens.set(mint, item);

    // Notify listeners
    for (const listener of newCandidateListeners) {
      try { listener(item); } catch {}
    }
  }
}

/**
 * Returns recent WebSocket-discovered tokens, sorted by real-time activity and recency.
 */
export function getRecentWsDiscoveredTokens(limit: number = 16): DiscoveredWsToken[] {
  const now = Date.now();
  // Filter out expired tokens (>30m)
  const active: DiscoveredWsToken[] = [];
  for (const [mint, item] of discoveredTokens.entries()) {
    if (now - item.detectedAt < CACHE_TTL_MS) {
      active.push(item);
    } else {
      discoveredTokens.delete(mint);
    }
  }

  // Sort by activity count and recency
  return active
    .sort((a, b) => (b.activityCount * 1000 + b.detectedAt) - (a.activityCount * 1000 + a.detectedAt))
    .slice(0, limit);
}

export function onNewTokenDiscovered(callback: (token: DiscoveredWsToken) => void): void {
  newCandidateListeners.push(callback);
}

export function stopSolanaWsStream(): void {
  if (wsSubscriptionId !== null) {
    try {
      wsConnection.removeOnLogsListener(wsSubscriptionId);
    } catch {}
    wsSubscriptionId = null;
  }
  isWsStreamActive = false;
  console.log('[SolanaWsStream] 🛑 WebSocket Stream dihentikan.');
}
