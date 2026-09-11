import axios from 'axios';

export interface RealFeeBreakdown {
  baseSignatureFeeSol: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  totalTxFeeSol: number;
  source: 'LIVE_HELIUS_AND_JITO' | 'CACHED_ONCHAIN' | 'FALLBACK_FLOOR';
  updatedAt: number;
}

let cachedRegularFee: RealFeeBreakdown | null = null;
let cachedEmergencyFee: RealFeeBreakdown | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds TTL

const HELIUS_KEY = '7ea0d05e-8355-43d8-967e-b887f0d5b1b8';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

export async function fetchLiveSolanaFees(): Promise<{ regular: RealFeeBreakdown; emergency: RealFeeBreakdown }> {
  let regularPriorityMicroLamports = 50_000; // default 50k
  let emergencyPriorityMicroLamports = 150_000;
  let regularJitoTipSol = 0.00005;
  let emergencyJitoTipSol = 0.00015;

  // 1. Fetch Helius Priority Fee Estimate
  try {
    const heliusRes = await axios.post(
      HELIUS_RPC_URL,
      {
        jsonrpc: '2.0',
        id: 'real-fee-est',
        method: 'getPriorityFeeEstimate',
        params: [
          {
            accountKeys: ['So11111111111111111111111111111111111111112'],
            options: { priorityLevel: 'High' }
          }
        ]
      },
      { timeout: 3000 }
    );
    if (heliusRes.data?.result?.priorityFeeEstimate) {
      regularPriorityMicroLamports = Number(heliusRes.data.result.priorityFeeEstimate);
      emergencyPriorityMicroLamports = regularPriorityMicroLamports * 2.5;
    }
  } catch (err: any) {
    // Keep baseline
  }

  // 2. Fetch Jito Live Tip Floor
  try {
    const jitoRes = await axios.get(JITO_TIP_FLOOR_URL, { timeout: 3000 });
    if (Array.isArray(jitoRes.data) && jitoRes.data.length > 0) {
      const tipData = jitoRes.data[0];
      if (tipData.landed_tips_75th_percentile) {
        regularJitoTipSol = Math.max(0.00001, Number(tipData.landed_tips_75th_percentile));
      }
      if (tipData.landed_tips_95th_percentile) {
        emergencyJitoTipSol = Math.max(0.00005, Number(tipData.landed_tips_95th_percentile));
      }
    }
  } catch (err: any) {
    // Keep baseline
  }

  const baseSignatureFeeSol = 0.000005; // Fixed 5000 lamports per tx on Solana
  const computeUnits = 200_000; // Average DEX swap compute units

  const regularPriorityFeeSol = (computeUnits * regularPriorityMicroLamports) / 1e15;
  const emergencyPriorityFeeSol = (computeUnits * emergencyPriorityMicroLamports) / 1e15;

  const now = Date.now();

  const regular: RealFeeBreakdown = {
    baseSignatureFeeSol,
    priorityFeeSol: regularPriorityFeeSol,
    jitoTipSol: regularJitoTipSol,
    totalTxFeeSol: baseSignatureFeeSol + regularPriorityFeeSol + regularJitoTipSol,
    source: 'LIVE_HELIUS_AND_JITO',
    updatedAt: now
  };

  const emergency: RealFeeBreakdown = {
    baseSignatureFeeSol,
    priorityFeeSol: emergencyPriorityFeeSol,
    jitoTipSol: emergencyJitoTipSol,
    totalTxFeeSol: baseSignatureFeeSol + emergencyPriorityFeeSol + emergencyJitoTipSol,
    source: 'LIVE_HELIUS_AND_JITO',
    updatedAt: now
  };

  cachedRegularFee = regular;
  cachedEmergencyFee = emergency;

  return { regular, emergency };
}

export async function getLiveExecutionFeeSol(isEmergency: boolean = false): Promise<RealFeeBreakdown> {
  const cached = isEmergency ? cachedEmergencyFee : cachedRegularFee;
  if (cached && (Date.now() - cached.updatedAt < CACHE_TTL_MS)) {
    return cached;
  }

  try {
    const { regular, emergency } = await fetchLiveSolanaFees();
    return isEmergency ? emergency : regular;
  } catch {
    if (cached) return cached;
    const baseSignatureFeeSol = 0.000005;
    const fallbackPriority = 0.000015;
    const fallbackJito = isEmergency ? 0.00015 : 0.00005;
    return {
      baseSignatureFeeSol,
      priorityFeeSol: fallbackPriority,
      jitoTipSol: fallbackJito,
      totalTxFeeSol: baseSignatureFeeSol + fallbackPriority + fallbackJito,
      source: 'FALLBACK_FLOOR',
      updatedAt: Date.now()
    };
  }
}
