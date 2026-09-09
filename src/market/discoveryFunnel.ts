import { TokenEntity, PoolEntity } from '../core/types';
import { SafetyGate, safetyGate } from './safetyGate';
import { RugCheckResult } from '../types/index';
import { CONFIG } from '../config';

const SYSTEM_PROGRAMS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun Program
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'So11111111111111111111111111111111111111112', // Native Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export interface FunnelCandidate {
  token: TokenEntity;
  pool: PoolEntity;
  liquidityUsd: number;
  volume24hUsd: number;
  marketCapUsd: number;
  priceUsd: number;
  tokenAgeSeconds?: number;
  bondingCurveProgressPct?: number;
  devHoldingPct?: number;
  uniqueHoldersCount?: number;
  safetyReport?: RugCheckResult | null;
  isCabalSuspect?: boolean;
}

export interface FunnelEvaluation {
  passed: boolean;
  stageFailed?: 
    | 'BASIC_ELIGIBILITY' 
    | 'SURVIVAL_PHASE_AGE' 
    | 'BONDING_CURVE_GATE' 
    | 'DEV_CONCENTRATION' 
    | 'HOLDER_DISPERSION' 
    | 'LIQUIDITY_FILTER' 
    | 'ACTIVITY_FILTER' 
    | 'SAFETY_GATE';
  reason?: string;
  riskScore: number;
}

export class DiscoveryFunnel {
  private safety: SafetyGate;

  constructor(safety: SafetyGate = safetyGate) {
    this.safety = safety;
  }

  /**
   * Evaluates a discovered candidate through the progressive funnel
   */
  public evaluateCandidate(candidate: FunnelCandidate): FunnelEvaluation {
    const { 
      token, 
      pool, 
      liquidityUsd, 
      volume24hUsd, 
      marketCapUsd, 
      tokenAgeSeconds,
      bondingCurveProgressPct,
      devHoldingPct,
      uniqueHoldersCount,
      safetyReport, 
      isCabalSuspect 
    } = candidate;

    // STAGE 1: Basic Eligibility (Non-system, valid address length)
    if (!token.address || token.address.length < 32 || SYSTEM_PROGRAMS.has(token.address)) {
      return {
        passed: false,
        stageFailed: 'BASIC_ELIGIBILITY',
        reason: 'Address merupakan Solana System Program atau token blacklist',
        riskScore: 100
      };
    }

    // STAGE 2: Institutional Survival Phase - Age Filter (Anti-Detik-0 Suicide)
    const minAgeSec = CONFIG.MIN_TOKEN_AGE_SEC || 180;
    if (tokenAgeSeconds !== undefined && tokenAgeSeconds < minAgeSec) {
      return {
        passed: false,
        stageFailed: 'SURVIVAL_PHASE_AGE',
        reason: `Token terlalu muda (${tokenAgeSeconds}s < ${minAgeSec}s). Fase Genesis/Detik-0 sangat rawan dev bundling & instant rugpull. Menunggu shakeout!`,
        riskScore: 95
      };
    }

    const maxAgeHours = CONFIG.MAX_TOKEN_AGE_HOURS || 24;
    if (tokenAgeSeconds !== undefined && tokenAgeSeconds > (maxAgeHours * 3600)) {
      return {
        passed: false,
        stageFailed: 'SURVIVAL_PHASE_AGE',
        reason: `Token melebihi batas umur momentum (${(tokenAgeSeconds / 3600).toFixed(1)}j > ${maxAgeHours}j). Menghindari koin zombie mati.`,
        riskScore: 70
      };
    }

    // STAGE 3: Pump.fun Bonding Curve Sweet Spot Gate
    const isPumpFun = token.isPumpFun || token.address.endsWith('pump');
    if (isPumpFun && bondingCurveProgressPct !== undefined) {
      const minCurve = CONFIG.BONDING_CURVE_MIN_PCT || 25.0;
      const maxCurve = CONFIG.BONDING_CURVE_MAX_PCT || 85.0;

      if (bondingCurveProgressPct < minCurve) {
        return {
          passed: false,
          stageFailed: 'BONDING_CURVE_GATE',
          reason: `Progres bonding curve (${bondingCurveProgressPct.toFixed(1)}%) di bawah batas aman (Min: ${minCurve}%). Dev masih menguasai mayoritas likuiditas virtual.`,
          riskScore: 85
        };
      }

      if (bondingCurveProgressPct > maxCurve) {
        return {
          passed: false,
          stageFailed: 'BONDING_CURVE_GATE',
          reason: `Progres bonding curve (${bondingCurveProgressPct.toFixed(1)}%) di zona bahaya migrasi Raydium (> ${maxCurve}%). Rawan jeda freeze transaksi.`,
          riskScore: 80
        };
      }
    }

    // STAGE 4: Dev Holding & Sybil Concentration Filter
    const maxDevHolding = CONFIG.MAX_DEV_HOLDING_PCT || 5.0;
    if (devHoldingPct !== undefined && devHoldingPct > maxDevHolding) {
      return {
        passed: false,
        stageFailed: 'DEV_CONCENTRATION',
        reason: `Dev wallet menguasai ${devHoldingPct.toFixed(1)}% supply (Batas maks: ${maxDevHolding}%). Risiko dump masif ke pasar.`,
        riskScore: 90
      };
    }

    // STAGE 5: Unique Buyer Dispersion
    const minHolders = CONFIG.MIN_UNIQUE_HOLDERS || 45;
    if (uniqueHoldersCount !== undefined && uniqueHoldersCount < minHolders) {
      return {
        passed: false,
        stageFailed: 'HOLDER_DISPERSION',
        reason: `Jumlah unique holders (${uniqueHoldersCount}) kurang dari batas minimum (${minHolders}). Distribusi wallet belum organik.`,
        riskScore: 75
      };
    }

    // STAGE 6: Minimum Liquidity Depth
    const minLiquidity = CONFIG.MIN_LIQUIDITY_USD || 6000;
    if (liquidityUsd < minLiquidity) {
      return {
        passed: false,
        stageFailed: 'LIQUIDITY_FILTER',
        reason: `Likuiditas pool ($${liquidityUsd.toFixed(0)}) di bawah standar floor ($${minLiquidity})`,
        riskScore: 90
      };
    }

    // STAGE 7: Activity & Market Depth
    const minVolume = CONFIG.MIN_VOLUME_24H_USD || 25000;
    if (volume24hUsd > 0 && volume24hUsd < minVolume) {
      return {
        passed: false,
        stageFailed: 'ACTIVITY_FILTER',
        reason: `Volume 24 jam ($${volume24hUsd.toFixed(0)}) terlalu sepi (Min: $${minVolume})`,
        riskScore: 75
      };
    }

    // STAGE 8: Deterministic Safety Gate
    const audit = this.safety.evaluateTokenSafety({
      tokenAddress: token.address,
      safetyReport,
      isCabalSuspect,
      liquidityUsd,
      marketCapUsd
    });

    if (!audit.allowed) {
      return {
        passed: false,
        stageFailed: 'SAFETY_GATE',
        reason: audit.hardViolations.join('; ') || 'Skor risiko keamanan melebihi toleransi',
        riskScore: audit.riskScore
      };
    }

    return {
      passed: true,
      riskScore: audit.riskScore
    };
  }
}

export const discoveryFunnel = new DiscoveryFunnel();
