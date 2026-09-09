import { PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { Whale } from '../types/index';
import { connection } from './solanaConnection';

// In-memory cache for wallet funder addresses (wallet -> funder)
const funderCache: Map<string, string> = new Map();

// Known major CEX hot wallets (to avoid false-positive clustering when whales withdraw from Binance/Bybit/Coinbase)
const KNOWN_EXCHANGE_WALLETS = new Set([
  '5tzFkiKscGBspau3z4K5uhuMrWvn4K487m83PZgDMC5b', // Binance Hot Wallet
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', // Coinbase
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', // Bybit
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Kucoin
  'u6PJ8DtQuPFnfmwHbGFULQ4u4EgsvV8M5iZ47AwMtNx', // Gate.io
]);

/**
 * Discovers the original SOL funder (funder address) of a given Solana wallet.
 */
export async function getWhaleInitialFunder(walletAddress: string): Promise<string | null> {
  if (funderCache.has(walletAddress)) {
    return funderCache.get(walletAddress)!;
  }

  try {
    const pubkey = new PublicKey(walletAddress);
    
    // Get signatures (up to lookback limit)
    const sigs = await connection.getSignaturesForAddress(pubkey, { 
      limit: CONFIG.CABAL_MAX_TX_LOOKBACK 
    });

    if (!sigs || sigs.length === 0) return null;

    // The oldest transaction in the fetched batch
    const oldestSig = sigs[sigs.length - 1].signature;

    const tx = await connection.getParsedTransaction(oldestSig, {
      maxSupportedTransactionVersion: 0
    });

    if (!tx || !tx.meta) return null;

    let funder: string | null = null;

    // Check parsed system program transfers
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if ('parsed' in ix && ix.program === 'system') {
        const parsed = ix.parsed;
        if (parsed.type === 'transfer' && parsed.info.destination === walletAddress) {
          funder = parsed.info.source;
          break;
        }
      }
    }

    // Fallback: If not an explicit system transfer, check fee payer if different
    if (!funder) {
      const feePayer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58();
      if (feePayer && feePayer !== walletAddress) {
        funder = feePayer;
      }
    }

    if (funder) {
      funderCache.set(walletAddress, funder);
      return funder;
    }
  } catch (err: any) {
    console.error(`[CabalDetector] Error checking funder for ${walletAddress}:`, err.message);
  }

  return null;
}

export interface CabalAuditResult {
  isCabal: boolean;
  sharedFunder?: string;
  isExchange: boolean;
  matchingWhales: string[];
}

/**
 * Checks if a candidate wallet shares a funding source with any currently tracked whales.
 */
export async function isCabalSuspect(
  candidateAddress: string,
  existingWhales: Whale[]
): Promise<CabalAuditResult> {
  if (!CONFIG.CABAL_SHIELD_ENABLED) {
    return { isCabal: false, isExchange: false, matchingWhales: [] };
  }

  const candidateFunder = await getWhaleInitialFunder(candidateAddress);
  if (!candidateFunder) {
    return { isCabal: false, isExchange: false, matchingWhales: [] };
  }

  // If funded by a major CEX, it's not considered a cabal cluster
  if (KNOWN_EXCHANGE_WALLETS.has(candidateFunder)) {
    return { isCabal: false, sharedFunder: candidateFunder, isExchange: true, matchingWhales: [] };
  }

  const matchingWhales: string[] = [];

  for (const whale of existingWhales) {
    if (whale.address === candidateAddress) continue;

    let existingFunder = funderCache.get(whale.address);
    if (!existingFunder) {
      existingFunder = await getWhaleInitialFunder(whale.address) || undefined;
    }

    if (existingFunder && existingFunder === candidateFunder) {
      matchingWhales.push(whale.label);
    }
  }

  const isCabal = matchingWhales.length > 0;
  return {
    isCabal,
    sharedFunder: candidateFunder,
    isExchange: false,
    matchingWhales
  };
}

/**
 * Audits the entire active whale list to map out any hidden clusters.
 */
export async function auditAllWhalesForClusters(whales: Whale[]): Promise<{
  clusters: Array<{ funder: string; whales: string[] }>;
  cleanCount: number;
}> {
  const funderMap: Map<string, string[]> = new Map(); // funder -> whale labels

  for (const whale of whales) {
    const funder = await getWhaleInitialFunder(whale.address);
    if (funder && !KNOWN_EXCHANGE_WALLETS.has(funder)) {
      const current = funderMap.get(funder) || [];
      current.push(whale.label);
      funderMap.set(funder, current);
    }
  }

  const clusters: Array<{ funder: string; whales: string[] }> = [];
  let cabalWhalesCount = 0;

  for (const [funder, labels] of funderMap.entries()) {
    if (labels.length > 1) {
      clusters.push({ funder, whales: labels });
      cabalWhalesCount += labels.length;
    }
  }

  return {
    clusters,
    cleanCount: whales.length - cabalWhalesCount
  };
}
