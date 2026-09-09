import { MarketEvent, DataQuality } from '../core/types';
import { IStorageRepository } from '../storage/interfaces';

export class MarketDataEngine {
  private seenEvents: Set<string> = new Set();
  private maxSeenCacheSize = 5000;
  private storage: IStorageRepository;

  constructor(storage: IStorageRepository) {
    this.storage = storage;
  }

  /**
   * Normalizes incoming raw price/swap feeds into standardized MarketEvent
   */
  public async ingestEvent(raw: {
    eventId: string;
    tokenId: string;
    tokenSymbol: string;
    poolAddress: string;
    source: 'HELIUS_WS' | 'DEXSCREENER' | 'PUMPFUN_PDA' | 'BACKTEST_FEED';
    eventType: 'SWAP' | 'LIQUIDITY_ADD' | 'LIQUIDITY_REMOVE' | 'TICK_PRICE';
    slot?: number;
    timestampMs?: number;
    priceUsd: number;
    priceNative: number;
    volumeUsd: number;
    liquidityUsd: number;
    makerAddress?: string;
    isBuy?: boolean;
    tradeSizeSol?: number;
  }): Promise<MarketEvent | null> {
    // 1. Deduplication Gate
    if (this.seenEvents.has(raw.eventId)) {
      return null; // Duplicate dropped
    }
    this.seenEvents.add(raw.eventId);
    if (this.seenEvents.size > this.maxSeenCacheSize) {
      const iter = this.seenEvents.values();
      for (let i = 0; i < 1000; i++) {
        const val = iter.next().value;
        if (val) this.seenEvents.delete(val);
      }
    }

    const now = Date.now();
    const eventTime = raw.timestampMs || now;
    const latencyMs = Math.max(0, now - eventTime);

    // 2. Data Quality Evaluation
    let dataQuality: DataQuality = 'VALID';
    if (latencyMs > 45000) {
      dataQuality = 'STALE';
    }
    if (raw.priceUsd <= 0 || isNaN(raw.priceUsd) || raw.liquidityUsd < 0) {
      dataQuality = 'SUSPICIOUS';
    }

    const normalized: MarketEvent = {
      eventId: raw.eventId,
      tokenId: raw.tokenId,
      tokenSymbol: raw.tokenSymbol,
      poolAddress: raw.poolAddress,
      source: raw.source,
      eventType: raw.eventType,
      slot: raw.slot,
      timestampMs: eventTime,
      priceUsd: raw.priceUsd,
      priceNative: raw.priceNative,
      volumeUsd: raw.volumeUsd,
      liquidityUsd: raw.liquidityUsd,
      makerAddress: raw.makerAddress,
      isBuy: raw.isBuy ?? true,
      tradeSizeSol: raw.tradeSizeSol ?? 0,
      dataQuality,
      ingestionLatencyMs: latencyMs
    };

    // 3. Persist normalized event
    await this.storage.recordMarketEvent(normalized);

    return normalized;
  }
}
