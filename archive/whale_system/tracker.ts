import { PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { CONFIG } from '../config';
import { getActiveWhales } from '../db/index';
import { Whale } from '../types/index';
import { getDedicatedConnection, getDedicatedEndpoint } from './solanaConnection';

const trackerEndpoint = getDedicatedEndpoint('WHALE_TRACKER');
const wsUrl = trackerEndpoint.wsUrl;
const connection = getDedicatedConnection('WHALE_TRACKER');

// Known DEX Program IDs on Solana
const DEX_PROGRAM_IDS = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium Liquidity Pool V4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Pools
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter V4
]);

const IGNORED_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // Native SOL / WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export type WhaleBuyCallback = (
  whale: Whale,
  tokenMint: string,
  solSpent: number,
  txSignature: string,
  tokensReceived?: number
) => Promise<void>;

export type WhaleTradeCallback = (
  whale: Whale,
  tokenMint: string,
  action: 'BUY' | 'SELL',
  solAmount: number,
  txSignature: string,
  tokenAmount?: number
) => Promise<void>;

let onWhaleBuyHandler: WhaleBuyCallback | null = null;
let onWhaleTradeHandler: WhaleTradeCallback | null = null;

export function setWhaleBuyHandler(handler: WhaleBuyCallback) {
  onWhaleBuyHandler = handler;
}

export function setWhaleTradeHandler(handler: WhaleTradeCallback) {
  onWhaleTradeHandler = handler;
}
const activeSubscriptions: Map<number, number> = new Map(); // whale.id -> subscriptionId
const processedSignatures: Set<string> = new Set();
const txQueue: Array<{ whale: Whale; sig: string }> = [];
let isProcessingQueue = false;
let fallbackInterval: NodeJS.Timeout | null = null;
let isTrackerRunning = false;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function queueTransaction(whale: Whale, sig: string) {
  if (processedSignatures.has(sig)) return;
  processedSignatures.add(sig);

  if (processedSignatures.size > 1000) {
    const oldest = processedSignatures.values().next().value;
    if (oldest) processedSignatures.delete(oldest);
  }

  txQueue.push({ whale, sig });
  processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (txQueue.length > 0) {
    const item = txQueue.shift();
    if (item) {
      try {
        console.log(`[WhaleTracker] ⚡ Processing WS Event for ${item.whale.label} (Sig: ${item.sig.slice(0, 10)}...)`);
        await parseAndExecuteBuy(item.whale, item.sig);
      } catch (err: any) {
        // Continue queue gracefully
      }
      await sleep(600); // 600ms pacing to eliminate 429 burst rate limits
    }
  }

  isProcessingQueue = false;
}

export function startWhaleTracker() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  console.log(`[WhaleTracker] ⚡ WebSocket Tracker Starting on: ${wsUrl}`);
  refreshWhaleSubscriptions();

  // Safety fallback poll every 60s to ensure zero dropped transactions
  fallbackInterval = setInterval(safetyFallbackPoll, 60000);
}

export function stopWhaleTracker() {
  isTrackerRunning = false;
  for (const [whaleId, subId] of activeSubscriptions.entries()) {
    try {
      connection.removeOnLogsListener(subId);
    } catch {
      // Ignore unsubscribe error
    }
  }
  activeSubscriptions.clear();

  if (fallbackInterval) {
    clearInterval(fallbackInterval);
    fallbackInterval = null;
  }
  console.log('[WhaleTracker] 🛑 WebSocket Tracker stopped.');
}

export function refreshWhaleSubscriptions() {
  const whales = getActiveWhales();

  // Remove existing subscriptions
  for (const [whaleId, subId] of activeSubscriptions.entries()) {
    try {
      connection.removeOnLogsListener(subId);
    } catch {}
  }
  activeSubscriptions.clear();

  if (whales.length === 0) {
    console.log('[WhaleTracker] ℹ️ Tidak ada dompet paus aktif untuk di-subscribe.');
    return;
  }

  // Subscribe to each whale's logs in real-time
  for (const whale of whales) {
    try {
      const pubkey = new PublicKey(whale.address);
      const subId = connection.onLogs(
        pubkey,
        async (logsCtx) => {
          if (logsCtx.err) return; // Skip failed on-chain transactions
          await queueTransaction(whale, logsCtx.signature);
        },
        'confirmed'
      );

      activeSubscriptions.set(whale.id, subId);
      console.log(`[WhaleTracker] 📡 Subscribed WS (ID: ${subId}) for ${whale.label} (\`${whale.address.slice(0, 6)}...${whale.address.slice(-6)}\`)`);
    } catch (err: any) {
      console.error(`[WhaleTracker] Gagal subscribe WebSocket untuk ${whale.address}:`, err.message);
    }
  }

  console.log(`[WhaleTracker] 🚀 ${activeSubscriptions.size} dompet paus sekarang terhubung via WebSocket Realtime (<400ms)!`);
}

async function parseAndExecuteBuy(whale: Whale, signature: string) {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });
    if (!tx || !tx.meta) return;

    const parsedTrade = extractTokenTradeFromTx(whale.address, tx);
    if (!parsedTrade) return;

    if (parsedTrade.action === 'BUY') {
      console.log(`[WhaleTracker] 🚨 ON-CHAIN BUY DETECTED! ${whale.label} memborong ${parsedTrade.tokenMint} (${parsedTrade.solAmount} SOL)`);
      if (onWhaleTradeHandler) {
        await onWhaleTradeHandler(whale, parsedTrade.tokenMint, 'BUY', parsedTrade.solAmount, signature, parsedTrade.tokenAmount);
      } else if (onWhaleBuyHandler) {
        await onWhaleBuyHandler(whale, parsedTrade.tokenMint, parsedTrade.solAmount, signature, parsedTrade.tokenAmount);
      }
    } else if (parsedTrade.action === 'SELL') {
      console.log(`[WhaleTracker] 🚨 ON-CHAIN SELL DETECTED! ${whale.label} membuang/menjual token ${parsedTrade.tokenMint} (${parsedTrade.tokenAmount} tokens)`);
      if (onWhaleTradeHandler) {
        await onWhaleTradeHandler(whale, parsedTrade.tokenMint, 'SELL', parsedTrade.solAmount, signature, parsedTrade.tokenAmount);
      }
    }
  } catch (err: any) {
    console.error(`[WhaleTracker] Error parsing tx ${signature}:`, err.message);
  }
}

function extractTokenTradeFromTx(
  whaleAddress: string,
  tx: ParsedTransactionWithMeta
): { action: 'BUY' | 'SELL'; tokenMint: string; solAmount: number; tokenAmount: number } | null {
  const meta = tx.meta;
  if (!meta) return null;

  // 1. Check if DEX programs are involved
  const instructions = tx.transaction.message.instructions;
  let isDexTransaction = false;

  for (const ix of instructions) {
    const progId = ix.programId.toBase58();
    if (DEX_PROGRAM_IDS.has(progId)) {
      isDexTransaction = true;
      break;
    }
  }

  if (!isDexTransaction && meta.innerInstructions) {
    for (const inner of meta.innerInstructions) {
      for (const ix of inner.instructions) {
        if (DEX_PROGRAM_IDS.has(ix.programId.toBase58())) {
          isDexTransaction = true;
          break;
        }
      }
      if (isDexTransaction) break;
    }
  }

  // 2. Calculate SOL change for the whale
  const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
  const whaleIndex = accountKeys.indexOf(whaleAddress);
  if (whaleIndex === -1) return null;

  const preSol = meta.preBalances[whaleIndex] || 0;
  const postSol = meta.postBalances[whaleIndex] || 0;
  const solDifference = Math.abs(preSol - postSol) / 1_000_000_000;

  // 3. Identify token balance increment or decrement
  const preTokenBalances = meta.preTokenBalances || [];
  const postTokenBalances = meta.postTokenBalances || [];

  for (const post of postTokenBalances) {
    if (post.owner === whaleAddress) {
      const tokenMint = post.mint;
      if (IGNORED_MINTS.has(tokenMint)) continue;

      const pre = preTokenBalances.find(p => p.accountIndex === post.accountIndex);
      const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
      const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');

      // Detect BUY: token balance increased and SOL decreased
      if (postAmount > preAmount && solDifference >= 0.02) {
        return {
          action: 'BUY',
          tokenMint,
          solAmount: parseFloat(solDifference.toFixed(4)),
          tokenAmount: postAmount - preAmount
        };
      }

      // Detect SELL: token balance decreased
      if (postAmount < preAmount && (preAmount - postAmount) > 0) {
        return {
          action: 'SELL',
          tokenMint,
          solAmount: parseFloat(solDifference.toFixed(4)),
          tokenAmount: preAmount - postAmount
        };
      }
    }
  }

  return null;
}

// Periodic safety net (every 60s) to catch any potential dropped WS packet
async function safetyFallbackPoll() {
  const whales = getActiveWhales();
  for (const whale of whales) {
    try {
      const pubkey = new PublicKey(whale.address);
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 3 });
      for (const sigInfo of signatures) {
        if (sigInfo.err) continue;
        if (!processedSignatures.has(sigInfo.signature)) {
          processedSignatures.add(sigInfo.signature);
          await parseAndExecuteBuy(whale, sigInfo.signature);
        }
      }
    } catch {}
  }
}
