import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { getLiveExecutionFeeSol, RealFeeBreakdown } from './realFeeEngine';
import { getDedicatedConnection } from './solanaConnection';

const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const mintDecimalsCache = new Map<string, number>();

export async function getMintDecimals(mintAddress: string): Promise<number> {
  if (mintAddress.endsWith('pump')) return 6;
  if (mintDecimalsCache.has(mintAddress)) {
    return mintDecimalsCache.get(mintAddress)!;
  }
  try {
    const conn = getDedicatedConnection('GENERAL');
    const info = await conn.getParsedAccountInfo(new PublicKey(mintAddress));
    const parsed = (info.value?.data as any)?.parsed?.info;
    if (parsed && typeof parsed.decimals === 'number') {
      const decimals = parsed.decimals;
      mintDecimalsCache.set(mintAddress, decimals);
      return decimals;
    }
  } catch (err: any) {
    console.warn(`[DexSimulator] Gagal fetch decimals on-chain untuk ${mintAddress}: ${err.message}`);
  }
  return 6; // Standard SPL fallback
}

export interface RealisticSellResult {
  success: boolean;
  effectiveExitPriceUsd: number;
  grossSol: number;
  netSol: number;
  priceImpactPct: number;
  networkFeeSol: number;
  dexFeeSol: number;
  feeBreakdown?: RealFeeBreakdown;
  executionMethod: 'JUPITER_LIVE_QUOTE' | 'AMM_CONSTANT_PRODUCT' | 'POOL_EXHAUSTION_LIMIT';
  isFlashWickRejected: boolean;
  simulatedLatencyMs: number;
  warning?: string;
}

export interface RealisticBuyResult {
  success: boolean;
  effectiveEntryPriceUsd: number;
  tokensAcquired: number;
  effectiveSolSpent: number;
  priceImpactPct: number;
  networkFeeSol: number;
  feeBreakdown?: RealFeeBreakdown;
  executionMethod: 'JUPITER_LIVE_QUOTE' | 'AMM_CONSTANT_PRODUCT';
  warning?: string;
}

/**
 * Simulates real-market DEX swap for selling tokens to SOL.
 * Queries Jupiter live router first. If no route or pool unindexed, falls back
 * to strict Constant Product AMM (x * y = k) depth mechanics.
 * Deducts live Solana on-chain network fee (Base + Priority + Jito tip) from real sources.
 */
export async function simulateRealisticSell(
  tokenMint: string,
  amountTokens: number,
  currentPriceUsd: number,
  solPriceUsd: number,
  poolLiquidityUsd: number = 20000,
  slippagePct: number = CONFIG.SLIPPAGE_PCT,
  isEmergencyDump: boolean = false
): Promise<RealisticSellResult> {
  const isPump = tokenMint.endsWith('pump');
  const decimals = await getMintDecimals(tokenMint);
  const rawTokenAmount = Math.floor(amountTokens * Math.pow(10, decimals));
  // Exact On-Chain DEX Fees: Pump.fun is 1.25% (0.95% protocol + 0.30% creator fee), Raydium is 0.25%
  const dexFeePct = isPump ? 1.25 : 0.25;

  // Fetch live on-chain execution fee (Base + Priority + Jito Tip Floor)
  const liveFee = await getLiveExecutionFeeSol(isEmergencyDump);
  const networkFeeSol = liveFee.totalTxFeeSol;

  // Realistic latency simulation (Solana block inclusion 400ms - 800ms)
  // If panic dump: simulate 1x transaction revert (slippage gap) requiring priority fee escalation & re-broadcast (1200ms - 2000ms delay)
  const simulatedLatencyMs = isEmergencyDump 
    ? 1200 + Math.floor(Math.random() * 800)
    : 400 + Math.floor(Math.random() * 400);

  // Extra adverse slippage penalty on emergency dumps (simulates price dropping further during tx revert & retry)
  const emergencyDumpSlipPenalty = isEmergencyDump ? (0.02 + (Math.random() * 0.025)) : 0.0;

  // 1. ATTEMPT LIVE JUPITER QUOTE (Real on-chain router)
  if (rawTokenAmount > 0) {
    try {
      const effectiveSlippagePct = isEmergencyDump ? Math.max(8.0, slippagePct * 2.5) : slippagePct;
      const slippageBps = Math.floor(effectiveSlippagePct * 100);
      const res = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
        params: {
          inputMint: tokenMint,
          outputMint: SOL_MINT,
          amount: String(rawTokenAmount),
          slippageBps
        },
        timeout: 4000
      });

      if (res.data && res.data.outAmount) {
        const guaranteedLamports = Number(res.data.otherAmountThreshold || res.data.outAmount);
        const priceImpact = parseFloat(res.data.priceImpactPct || '0');

        if (priceImpact > 25.0) {
          console.warn(`[DexSimulator] ⚠️ High Price Impact on Jupiter Quote for ${tokenMint}: ${priceImpact.toFixed(2)}%`);
        }

        // Realistic block slip + emergency dump penalty
        const adverseSlipMultiplier = Math.max(0.92, (1 - emergencyDumpSlipPenalty) * (1 - (Math.random() * 0.003)));
        const realGrossSol = (guaranteedLamports / 1e9) * adverseSlipMultiplier;
        const dexFeeSol = realGrossSol * (dexFeePct / 100);
        const netSolAfterDex = realGrossSol - dexFeeSol;
        const netSol = Math.max(0, netSolAfterDex - networkFeeSol);

        const effectiveExitPriceUsd = (realGrossSol * solPriceUsd) / (amountTokens > 0 ? amountTokens : 1);

        return {
          success: true,
          effectiveExitPriceUsd,
          grossSol: realGrossSol,
          netSol,
          priceImpactPct: priceImpact,
          networkFeeSol,
          dexFeeSol,
          feeBreakdown: liveFee,
          executionMethod: 'JUPITER_LIVE_QUOTE',
          isFlashWickRejected: false,
          simulatedLatencyMs,
          warning: isEmergencyDump ? `Emergency dump re-try simulated (+${simulatedLatencyMs}ms delay, -${(emergencyDumpSlipPenalty * 100).toFixed(1)}% slippage gap)` : undefined
        };
      }
    } catch (err: any) {
      const errMsg = err.response?.data?.error || err.message;
      console.log(`[DexSimulator] Jupiter quote unroutable for ${tokenMint} (${errMsg}). Falling back to Constant Product AMM.`);
    }
  }

  // 2. FALLBACK: AMM CONSTANT PRODUCT (x * y = k) SIMULATOR
  const safeLiquidityUsd = Math.max(500, poolLiquidityUsd);
  const poolSolReserve = safeLiquidityUsd / (2 * solPriceUsd);
  const poolTokenReserve = currentPriceUsd > 0 ? safeLiquidityUsd / (2 * currentPriceUsd) : 1_000_000;

  const deltaX = amountTokens;
  const theoreticalGrossSol = (poolSolReserve * deltaX) / (poolTokenReserve + deltaX);
  const ammPriceImpactPct = Math.min(99.0, (deltaX / (poolTokenReserve + deltaX)) * 100);

  const maxExtractableSol = poolSolReserve * 0.15;
  const isCapped = theoreticalGrossSol > maxExtractableSol;
  const boundedGrossSol = Math.min(theoreticalGrossSol, maxExtractableSol);
  const isFlashWick = theoreticalGrossSol > (poolSolReserve * 0.30);

  const adverseSlipMultiplier = Math.max(0.95, 1 - ((ammPriceImpactPct / 100) * 0.5) - (Math.random() * 0.005));
  const actualGrossSol = boundedGrossSol * adverseSlipMultiplier;
  const dexFeeSol = actualGrossSol * (dexFeePct / 100);
  const netSolAfterDex = actualGrossSol - dexFeeSol;
  const netSol = Math.max(0, netSolAfterDex - networkFeeSol);

  const effectiveExitPriceUsd = (actualGrossSol * solPriceUsd) / (amountTokens > 0 ? amountTokens : 1);

  return {
    success: true,
    effectiveExitPriceUsd,
    grossSol: actualGrossSol,
    netSol,
    priceImpactPct: ammPriceImpactPct,
    networkFeeSol,
    dexFeeSol,
    feeBreakdown: liveFee,
    executionMethod: isCapped ? 'POOL_EXHAUSTION_LIMIT' : 'AMM_CONSTANT_PRODUCT',
    isFlashWickRejected: isFlashWick,
    simulatedLatencyMs,
    warning: isFlashWick 
      ? `Flash-wick liquidity cap applied: pool only has ${poolSolReserve.toFixed(2)} SOL. Max extracted: ${boundedGrossSol.toFixed(4)} SOL.` 
      : (isCapped ? `Order exceeded safe pool capacity. Price impact: ${ammPriceImpactPct.toFixed(1)}%` : undefined)
  };
}

/**
 * Simulates real-market DEX swap for buying tokens with SOL.
 * Checks Jupiter quote or AMM buy impact so entry price matches real DEX execution.
 * Deducts live on-chain Solana fees.
 */
export async function simulateRealisticBuy(
  tokenMint: string,
  amountSol: number,
  currentPriceUsd: number,
  solPriceUsd: number,
  poolLiquidityUsd: number = 20000,
  slippagePct: number = CONFIG.SLIPPAGE_PCT
): Promise<RealisticBuyResult> {
  const isPump = tokenMint.endsWith('pump');
  const decimals = await getMintDecimals(tokenMint);
  // Exact On-Chain DEX Fees: Pump.fun is 1.25% (0.95% protocol + 0.30% creator fee), Raydium is 0.25%
  const dexFeePct = isPump ? 1.25 : 0.25;

  // Live on-chain network fee (Base 5k lamports + Helius Priority + Jito Tip Floor)
  const liveFee = await getLiveExecutionFeeSol(false);
  const buyFeeSol = liveFee.totalTxFeeSol;
  const inLamports = Math.floor(amountSol * 1e9);

  // 1. ATTEMPT LIVE JUPITER QUOTE
  try {
    const slippageBps = Math.floor(slippagePct * 100);
    const res = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
      params: {
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: String(inLamports),
        slippageBps
      },
      timeout: 4000
    });

    if (res.data && res.data.outAmount) {
      const guaranteedTokensRaw = Number(res.data.otherAmountThreshold || res.data.outAmount);
      const tokensAcquired = guaranteedTokensRaw / Math.pow(10, decimals);
      const priceImpact = parseFloat(res.data.priceImpactPct || '0');
      const effectiveEntryPriceUsd = (amountSol * solPriceUsd) / (tokensAcquired > 0 ? tokensAcquired : 1);

      return {
        success: true,
        effectiveEntryPriceUsd,
        tokensAcquired,
        effectiveSolSpent: amountSol,
        priceImpactPct: priceImpact,
        networkFeeSol: buyFeeSol,
        feeBreakdown: liveFee,
        executionMethod: 'JUPITER_LIVE_QUOTE'
      };
    }
  } catch (err: any) {
    // Fallback to AMM math
  }

  // 2. FALLBACK: AMM CONSTANT PRODUCT
  const safeLiquidityUsd = Math.max(500, poolLiquidityUsd);
  const poolSolReserve = safeLiquidityUsd / (2 * solPriceUsd);
  const poolTokenReserve = currentPriceUsd > 0 ? safeLiquidityUsd / (2 * currentPriceUsd) : 1_000_000;

  const deltaY = amountSol * (1 - dexFeePct / 100);
  const tokensAcquired = (poolTokenReserve * deltaY) / (poolSolReserve + deltaY);
  const priceImpactPct = Math.min(99.0, (deltaY / (poolSolReserve + deltaY)) * 100);

  const effectiveEntryPriceUsd = (amountSol * solPriceUsd) / (tokensAcquired > 0 ? tokensAcquired : 1);

  return {
    success: true,
    effectiveEntryPriceUsd,
    tokensAcquired,
    effectiveSolSpent: amountSol,
    priceImpactPct,
    networkFeeSol: buyFeeSol,
    feeBreakdown: liveFee,
    executionMethod: 'AMM_CONSTANT_PRODUCT'
  };
}
