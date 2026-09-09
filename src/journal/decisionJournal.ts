import { DecisionJournalRecord, DecisionType, FeatureVector, MarketRegimeType } from '../core/types';
import { IStorageRepository } from '../storage/interfaces';

export class DecisionJournal {
  private storage: IStorageRepository;

  constructor(storage: IStorageRepository) {
    this.storage = storage;
  }

  /**
   * Records every evaluated candidate into the persistent journal
   */
  public async logCandidateDecision(params: {
    tokenId: string;
    tokenSymbol: string;
    decision: DecisionType;
    compositeScore: number;
    rejectionReasons?: string[];
    featuresSnapshot: Partial<FeatureVector>;
    regime: MarketRegimeType;
    strategyName: string;
    allocatedSol?: number;
  }): Promise<DecisionJournalRecord> {
    const record: DecisionJournalRecord = {
      decisionId: `DEC_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      tokenId: params.tokenId,
      tokenSymbol: params.tokenSymbol,
      decision: params.decision,
      compositeScore: params.compositeScore,
      rejectionReasons: params.rejectionReasons,
      featuresSnapshot: params.featuresSnapshot,
      regime: params.regime,
      strategyName: params.strategyName,
      allocatedSol: params.allocatedSol || 0,
      decidedAt: new Date().toISOString()
    };

    await this.storage.recordDecision(record);
    return record;
  }

  /**
   * Updates counterfactual return for skipped or executed decisions
   */
  public async updateCounterfactual(params: {
    decisionId: string;
    initialPriceUsd: number;
    price15mUsd?: number;
    price1hUsd?: number;
    price4hUsd?: number;
  }): Promise<void> {
    const { decisionId, initialPriceUsd, price15mUsd, price1hUsd, price4hUsd } = params;
    if (initialPriceUsd <= 0) return;

    const return15m = price15mUsd ? ((price15mUsd - initialPriceUsd) / initialPriceUsd) * 100 : undefined;
    const return1h = price1hUsd ? ((price1hUsd - initialPriceUsd) / initialPriceUsd) * 100 : undefined;
    const return4h = price4hUsd ? ((price4hUsd - initialPriceUsd) / initialPriceUsd) * 100 : undefined;

    await this.storage.updateCounterfactualOutcome(decisionId, {
      return15m: return15m !== undefined ? Number(return15m.toFixed(2)) : undefined,
      return1h: return1h !== undefined ? Number(return1h.toFixed(2)) : undefined,
      return4h: return4h !== undefined ? Number(return4h.toFixed(2)) : undefined
    });
  }

  public async getRecentDecisions(limit: number = 50): Promise<DecisionJournalRecord[]> {
    return this.storage.getDecisions(limit);
  }
}
