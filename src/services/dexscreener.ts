import axios from 'axios';
import { TokenMarketData } from '../types/index';

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex';
let cachedSolPriceUsd = 180.0;
let lastSolPriceFetch = 0;

export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (now - lastSolPriceFetch < 60000 && cachedSolPriceUsd > 0) {
    return cachedSolPriceUsd;
  }

  try {
    const res = await axios.get(`${DEXSCREENER_BASE_URL}/tokens/So11111111111111111111111111111111111111112`, {
      timeout: 5000
    });
    const pair = res.data?.pairs?.[0];
    if (pair && pair.priceUsd) {
      cachedSolPriceUsd = parseFloat(pair.priceUsd);
      lastSolPriceFetch = now;
      return cachedSolPriceUsd;
    }
  } catch (err) {
    // Fallback: keep cachedSolPriceUsd
  }
  return cachedSolPriceUsd;
}

// Short-lived token market data cache (3 seconds) to prevent 429 burst rate limits
const marketDataCache: Map<string, { data: TokenMarketData; timestamp: number }> = new Map();
const CACHE_TTL_MS = 3000;

export async function getTokenMarketData(tokenAddress: string): Promise<TokenMarketData | null> {
  const cached = marketDataCache.get(tokenAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await axios.get(`${DEXSCREENER_BASE_URL}/tokens/${tokenAddress}`, {
      timeout: 6000
    });

    const pairs = res.data?.pairs;
    if (!pairs || pairs.length === 0) {
      return null;
    }

    // Filter for Solana pairs and pick highest liquidity
    const solanaPairs = pairs.filter((p: any) => p.chainId === 'solana');
    const bestPair = (solanaPairs.length > 0 ? solanaPairs : pairs).sort(
      (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    if (!bestPair) return null;

    const data: TokenMarketData = {
      address: tokenAddress,
      symbol: bestPair.baseToken?.symbol || 'UNKNOWN',
      name: bestPair.baseToken?.name || 'Unknown Token',
      priceUsd: parseFloat(bestPair.priceUsd || '0'),
      priceNative: parseFloat(bestPair.priceNative || '0'),
      liquidityUsd: bestPair.liquidity?.usd || 0,
      fdv: bestPair.fdv || 0,
      marketCap: bestPair.marketCap || bestPair.fdv || 0,
      pairAddress: bestPair.pairAddress || '',
      dexId: bestPair.dexId || 'raydium',
      url: bestPair.url || `https://dexscreener.com/solana/${tokenAddress}`,
      priceChange24h: bestPair.priceChange?.h24 || 0,
      priceChange5m: bestPair.priceChange?.m5 || 0,
      volume24h: bestPair.volume?.h24 || 0,
    };

    marketDataCache.set(tokenAddress, { data, timestamp: Date.now() });

    // Cleanup old cache entries periodically
    if (marketDataCache.size > 200) {
      const now = Date.now();
      for (const [key, val] of marketDataCache.entries()) {
        if (now - val.timestamp > CACHE_TTL_MS * 2) {
          marketDataCache.delete(key);
        }
      }
    }

    return data;
  } catch (err: any) {
    console.error(`[DexScreener] Error fetching data for ${tokenAddress}:`, err.message);
    return null;
  }
}

/**
 * Institutional Risk Utility: Estimates the Price Impact of an order against the liquidity pool
 */
export function calculatePriceImpactPct(orderUsd: number, liquidityUsd: number): number {
  if (!liquidityUsd || liquidityUsd <= 0) return 100.0;
  // Constant-product AMM slippage approximation: Impact ≈ (Order Size / (Pool Liquidity / 2)) * 100
  const poolSideUsd = liquidityUsd / 2;
  return Math.min(100.0, (orderUsd / poolSideUsd) * 100);
}
