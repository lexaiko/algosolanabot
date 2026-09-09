import { 
  PublicKey, 
  SystemProgram, 
  TransactionInstruction, 
  ComputeBudgetProgram 
} from '@solana/web3.js';
import axios from 'axios';
import { CONFIG } from '../config';
import { connection } from './solanaConnection';

// Official Jito MEV Tip Accounts on Solana Mainnet
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pWHLnjvnxKLQm3AoZbxv',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/**
 * Returns a randomly selected Jito tip account to distribute load across validators.
 */
export function getRandomJitoTipAccount(): PublicKey {
  const randomIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[randomIndex]);
}

/**
 * Builds a SystemProgram transfer instruction to pay the Jito MEV tip bribe.
 */
export function buildJitoTipInstruction(
  payerPubkey: PublicKey,
  tipLamports: number = CONFIG.JITO_TIP_LAMPORTS
): TransactionInstruction {
  const tipAccount = getRandomJitoTipAccount();
  return SystemProgram.transfer({
    fromPubkey: payerPubkey,
    toPubkey: tipAccount,
    lamports: tipLamports
  });
}

/**
 * Sends a bundle of serialized base58 transactions directly to the Jito Block Engine.
 * Bypasses the public Solana mempool completely to prevent Sandwich / Frontrun attacks.
 */
export async function sendJitoBundle(
  serializedTransactions: string[]
): Promise<{ success: boolean; bundleId?: string; error?: string }> {
  if (!CONFIG.JITO_MEV_ENABLED) {
    return { success: false, error: 'Jito MEV protection is disabled in config.' };
  }

  try {
    const endpoint = `${CONFIG.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`;
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [serializedTransactions]
    };

    const response = await axios.post(endpoint, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000
    });

    if (response.data && response.data.result) {
      const bundleId = response.data.result;
      console.log(`[JitoMEV] 🛡️ Bundle submitted successfully! Bundle ID: ${bundleId}`);
      return { success: true, bundleId };
    }

    if (response.data && response.data.error) {
      console.error(`[JitoMEV] ❌ Bundle submission error:`, response.data.error);
      return { success: false, error: response.data.error.message || 'Unknown Jito error' };
    }
  } catch (err: any) {
    console.error(`[JitoMEV] ❌ Failed to reach Jito Block Engine:`, err.message);
    return { success: false, error: err.message };
  }

  return { success: false, error: 'Empty response from Jito Block Engine' };
}

/**
 * Calculates optimal Dynamic Priority Fee based on current network congestion.
 */
export async function getDynamicPriorityFee(
  fallbackMicroLamports: number = 50000
): Promise<TransactionInstruction> {
  try {
    const recentFees = await connection.getRecentPrioritizationFees();
    if (recentFees && recentFees.length > 0) {
      // Sort fees and pick the 75th percentile for fast confirmation
      const feeValues = recentFees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const p75Index = Math.floor(feeValues.length * 0.75);
      const optimalFee = Math.max(feeValues[p75Index] || fallbackMicroLamports, 10000);
      
      // Cap at 200,000 micro-lamports to avoid overpaying
      const cappedFee = Math.min(optimalFee, 200000);
      return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cappedFee });
    }
  } catch {
    // Fallback if RPC fails to fetch fees
  }

  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fallbackMicroLamports });
}
