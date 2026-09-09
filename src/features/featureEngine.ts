import { MarketEvent, FeatureVector, MarketRegimeType, DataQuality } from '../core/types';
import { IStorageRepository } from '../storage/interfaces';

export class FeatureEngine {
  private storage: IStorageRepository;

  constructor(storage: IStorageRepository) {
    this.storage = storage;
  }

  /**
   * Computes normalized quantitative features from event history and market state
   */
  public async computeFeatures(params: {
    tokenAddress: string;
    currentPriceUsd: number;
    currentLiquidityUsd: number;
    volume24hUsd?: number;
    priceChange5m?: number;
    priceChange24h?: number;
    bondingCurveProgressPct?: number;
    whaleNetFlowSol?: number;
    smartMoneyScore?: number;
    cabalRiskScore?: number;
    regime?: MarketRegimeType;
  }): Promise<FeatureVector> {
    const { 
      tokenAddress, 
      currentPriceUsd, 
      currentLiquidityUsd, 
      volume24hUsd = 0,
      priceChange5m = 0,
      priceChange24h = 0,
      bondingCurveProgressPct,
      whaleNetFlowSol = 0,
      smartMoneyScore = 50,
      cabalRiskScore = 15,
      regime = 'RANGE'
    } = params;

    // Fetch past market events from storage for rolling computation
    const pastEvents = await this.storage.getRecentMarketEvents(tokenAddress, 30);

    // 1. Price Structure Calculations
    const return5m = priceChange5m;
    const return15m = priceChange24h ? priceChange24h * 0.15 : return5m * 1.8;
    const return1m = pastEvents.length >= 2 
      ? ((currentPriceUsd - pastEvents[pastEvents.length - 2].priceUsd) / pastEvents[pastEvents.length - 2].priceUsd) * 100 
      : return5m * 0.25;

    // Realized Volatility: standard deviation of event prices
    let realizedVol = 5.0; // Baseline %
    if (pastEvents.length >= 5) {
      const prices = pastEvents.map(e => e.priceUsd);
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
      realizedVol = mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 5.0;
    }

    const peakPrice = pastEvents.length > 0 
      ? Math.max(currentPriceUsd, ...pastEvents.map(e => e.priceUsd))
      : currentPriceUsd;
    const drawdownFromPeakPct = peakPrice > 0 ? ((peakPrice - currentPriceUsd) / peakPrice) * 100 : 0;
    const breakoutDistancePct = return5m > 0 ? return5m * 0.8 : 0;

    // 2. Volume & Flow Imbalance
    const buyEvents = pastEvents.filter(e => e.isBuy);
    const sellEvents = pastEvents.filter(e => !e.isBuy);
    const totalBuyVol = buyEvents.reduce((s, e) => s + (e.volumeUsd || 0), 0);
    const totalSellVol = sellEvents.reduce((s, e) => s + (e.volumeUsd || 0), 0);
    const totalVol = totalBuyVol + totalSellVol;

    const buySellRatio = totalSellVol > 0 ? totalBuyVol / totalSellVol : totalBuyVol > 0 ? 3.0 : 1.0;
    const flowImbalance = totalVol > 0 ? (totalBuyVol - totalSellVol) / totalVol : 0; // -1 to +1

    // Volume Acceleration dV/dt
    const baselineVol = volume24hUsd > 0 ? volume24hUsd / (24 * 12) : 5000; // estimated 5m baseline
    const volume5mUsd = totalVol > 0 ? totalVol : baselineVol;
    const volumeAcceleration = baselineVol > 0 ? volume5mUsd / baselineVol : 1.0;

    // 3. Liquidity Microstructure
    const estimatedPriceImpactPct = currentLiquidityUsd > 0 
      ? Math.min(10.0, (150 / currentLiquidityUsd) * 100) // 1 SOL (~$150) impact approximation
      : 5.0;

    const vector: FeatureVector = {
      tokenId: tokenAddress,
      timestampMs: Date.now(),
      timeframe: '5m',
      return1m: Number(return1m.toFixed(2)),
      return5m: Number(return5m.toFixed(2)),
      return15m: Number(return15m.toFixed(2)),
      realizedVol: Number(realizedVol.toFixed(2)),
      atrPct: Number(Math.max(2.0, realizedVol * 1.2).toFixed(2)),
      breakoutDistancePct: Number(breakoutDistancePct.toFixed(2)),
      drawdownFromPeakPct: Number(drawdownFromPeakPct.toFixed(2)),
      volume5mUsd: Number(volume5mUsd.toFixed(0)),
      volumeAcceleration: Number(volumeAcceleration.toFixed(2)),
      buySellRatio: Number(buySellRatio.toFixed(2)),
      flowImbalance: Number(flowImbalance.toFixed(2)),
      tradeCount5m: Math.max(pastEvents.length, 5),
      avgTradeSizeUsd: pastEvents.length > 0 ? Number((volume5mUsd / pastEvents.length).toFixed(0)) : 100,
      liquidityUsd: currentLiquidityUsd,
      liquidityChangePct: 0,
      estimatedPriceImpactPct: Number(estimatedPriceImpactPct.toFixed(2)),
      bondingCurveProgressPct,
      whaleNetFlowSol,
      smartMoneyAccumulationScore: smartMoneyScore,
      cabalClusterRiskScore: cabalRiskScore,
      regime,
      quality: currentPriceUsd > 0 && currentLiquidityUsd > 0 ? 'VALID' : 'SUSPICIOUS'
    };

    // Persist snapshot to storage
    await this.storage.saveFeatureSnapshot(vector);

    return vector;
  }
}
