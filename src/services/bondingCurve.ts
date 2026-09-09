import { PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { connection } from './solanaConnection';

export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  spotPriceSol: number;
  marketCapSol: number;
  liquiditySol: number;
}

// In-memory RAM cache for bonding curve state (1500ms TTL)
const curveCache: Map<string, { state: BondingCurveState; timestamp: number }> = new Map();
const CURVE_CACHE_TTL_MS = 1500;

/**
 * Derives the PDA address for a Pump.fun token's bonding curve.
 */
export function getBondingCurveAddress(mintAddress: string): PublicKey {
  const mint = new PublicKey(mintAddress);
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  );
  return bondingCurve;
}

/**
 * Decodes the 49-81 byte raw on-chain buffer of the Pump.fun bonding curve account.
 */
export function decodeBondingCurveBuffer(buffer: Buffer): BondingCurveState | null {
  try {
    if (buffer.length < 49) return null;

    // Layout: 8 bytes discriminator, followed by 5 x u64 LE fields and 1 bool
    const virtualTokenReserves = buffer.readBigUInt64LE(8);
    const virtualSolReserves = buffer.readBigUInt64LE(16);
    const realTokenReserves = buffer.readBigUInt64LE(24);
    const realSolReserves = buffer.readBigUInt64LE(32);
    const tokenTotalSupply = buffer.readBigUInt64LE(40);
    const complete = buffer.readUInt8(48) === 1;

    // Spot price in SOL: (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6)
    const solAmt = Number(virtualSolReserves) / 1_000_000_000;
    const tokenAmt = Number(virtualTokenReserves) / 1_000_000;
    const spotPriceSol = tokenAmt > 0 ? solAmt / tokenAmt : 0;

    // Market cap: spotPriceSol * (tokenTotalSupply / 1e6)
    const totalSupplyNorm = Number(tokenTotalSupply) / 1_000_000;
    const marketCapSol = spotPriceSol * totalSupplyNorm;

    // Liquidity in SOL currently inside curve
    const liquiditySol = (Number(realSolReserves) / 1_000_000_000) * 2; // pool is 2-sided

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      spotPriceSol,
      marketCapSol,
      liquiditySol
    };
  } catch (err: any) {
    console.error('[BondingCurve] Buffer decode error:', err.message);
    return null;
  }
}

/**
 * Fetches and decodes the current on-chain bonding curve state directly from Solana RPC.
 * Bypasses all third-party APIs (0 HTTP latency to DexScreener/Jupiter).
 */
export async function getOnChainBondingCurve(tokenMint: string): Promise<BondingCurveState | null> {
  const cached = curveCache.get(tokenMint);
  if (cached && Date.now() - cached.timestamp < CURVE_CACHE_TTL_MS) {
    return cached.state;
  }

  try {
    const pda = getBondingCurveAddress(tokenMint);
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo || !accountInfo.data) return null;

    const state = decodeBondingCurveBuffer(accountInfo.data);
    if (state) {
      curveCache.set(tokenMint, { state, timestamp: Date.now() });
      return state;
    }
  } catch (err: any) {
    // Non-pump.fun token or network error
  }

  return null;
}

/**
 * Mathematical Constant Product AMM: Calculates exact tokens received for a given SOL amount.
 * Formula: new_tokens = k / (virtual_sol + sol_in)
 */
export function calculateBuyTokensFromCurve(
  curve: BondingCurveState,
  amountSol: number
): { tokensOut: number; priceImpactPct: number; effectivePriceSol: number } {
  const solInLamports = BigInt(Math.floor(amountSol * 1_000_000_000));
  const k = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newSolReserves = curve.virtualSolReserves + solInLamports;
  const newTokenReserves = k / newSolReserves;
  const tokensOutRaw = curve.virtualTokenReserves - newTokenReserves;

  const tokensOut = Number(tokensOutRaw) / 1_000_000;
  const effectivePriceSol = tokensOut > 0 ? amountSol / tokensOut : curve.spotPriceSol;
  const priceImpactPct = curve.spotPriceSol > 0
    ? ((effectivePriceSol - curve.spotPriceSol) / curve.spotPriceSol) * 100
    : 0;

  return { tokensOut, priceImpactPct, effectivePriceSol };
}

/**
 * Mathematical Constant Product AMM: Calculates exact SOL received for selling tokens.
 */
export function calculateSellSolFromCurve(
  curve: BondingCurveState,
  tokensAmount: number
): { solOut: number; priceImpactPct: number; effectivePriceSol: number } {
  const tokensInRaw = BigInt(Math.floor(tokensAmount * 1_000_000));
  const k = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newTokenReserves = curve.virtualTokenReserves + tokensInRaw;
  const newSolReserves = k / newTokenReserves;
  const solOutLamports = curve.virtualSolReserves - newSolReserves;

  const solOut = Number(solOutLamports) / 1_000_000_000;
  const effectivePriceSol = tokensAmount > 0 ? solOut / tokensAmount : curve.spotPriceSol;
  const priceImpactPct = curve.spotPriceSol > 0
    ? ((curve.spotPriceSol - effectivePriceSol) / curve.spotPriceSol) * 100
    : 0;

  return { solOut, priceImpactPct, effectivePriceSol };
}
