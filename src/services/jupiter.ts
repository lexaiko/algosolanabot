import axios from 'axios';
import { CONFIG } from '../config';

const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SwapQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: any[];
}

export async function getBuyQuote(tokenMint: string, amountSol: number): Promise<SwapQuote | null> {
  try {
    const lamports = Math.floor(amountSol * 1_000_000_000);
    const slippageBps = Math.floor(CONFIG.SLIPPAGE_PCT * 100);

    const res = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
      params: {
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: lamports,
        slippageBps
      },
      timeout: 5000
    });

    if (res.data && res.data.outAmount) {
      return {
        inAmount: res.data.inAmount,
        outAmount: res.data.outAmount,
        priceImpactPct: parseFloat(res.data.priceImpactPct || '0'),
        routePlan: res.data.routePlan || []
      };
    }
  } catch (err: any) {
    console.error(`[Jupiter] Buy quote error for ${tokenMint}:`, err.response?.data?.error || err.message);
  }
  return null;
}

export async function getSellQuote(tokenMint: string, tokenAmountRaw: number | string): Promise<SwapQuote | null> {
  try {
    const slippageBps = Math.floor(CONFIG.SLIPPAGE_PCT * 100);

    const res = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
      params: {
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: String(Math.floor(Number(tokenAmountRaw))),
        slippageBps
      },
      timeout: 5000
    });

    if (res.data && res.data.outAmount) {
      return {
        inAmount: res.data.inAmount,
        outAmount: res.data.outAmount,
        priceImpactPct: parseFloat(res.data.priceImpactPct || '0'),
        routePlan: res.data.routePlan || []
      };
    }
  } catch (err: any) {
    console.error(`[Jupiter] Sell quote error for ${tokenMint}:`, err.response?.data?.error || err.message);
  }
  return null;
}
