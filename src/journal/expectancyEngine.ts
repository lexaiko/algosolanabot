import { ExpectancyMetrics } from '../core/types';
import { IStorageRepository } from '../storage/interfaces';

export interface StrategyHealthEvaluation {
  status: 'HEALTHY_EDGE' | 'NEUTRAL' | 'DEGRADING_EDGE' | 'DEFENSIVE_MODE_REQUIRED';
  expectancy: ExpectancyMetrics;
  actionRecommendation: string;
  diagnostics: string[];
}

export class ExpectancyEngine {
  private storage: IStorageRepository;

  constructor(storage: IStorageRepository) {
    this.storage = storage;
  }

  /**
   * Computes comprehensive expectancy metrics and assesses statistical alpha decay
   */
  public async evaluateStrategyHealth(strategyName?: string): Promise<StrategyHealthEvaluation> {
    const metrics = await this.storage.calculateExpectancy(strategyName);
    const diagnostics: string[] = [];

    if (metrics.totalTrades < 5) {
      return {
        status: 'NEUTRAL',
        expectancy: metrics,
        actionRecommendation: 'Melanjutkan pengumpulan sampel trade (butuh min 5 trade tertutup)',
        diagnostics: ['Sampel statistik belum memadai untuk kesimpulan alpha decay']
      };
    }

    // Diagnostic 1: Expectancy in R
    if (metrics.expectancyR < 0) {
      diagnostics.push(`Ekspektasi matematis negatif (${metrics.expectancyR}R). Setiap trade secara rata-rata membakar modal.`);
    } else {
      diagnostics.push(`Ekspektasi matematis positif (+${metrics.expectancyR}R per trade) setelah friksi.`);
    }

    // Diagnostic 2: Profit Factor
    if (metrics.profitFactor < 1.0) {
      diagnostics.push(`Profit factor (${metrics.profitFactor}) di bawah 1.0 (Gross loss melebihi gross profit).`);
    }

    // Diagnostic 3: Win Rate vs Payoff Asymmetry
    if (metrics.winRate < 40 && metrics.payoffRatio < 2.0) {
      diagnostics.push(`Rasio asymmetric payoff (${metrics.payoffRatio}x) tidak mampu menutupi win-rate rendah (${metrics.winRate}%).`);
    }

    // Determine Health Status
    let status: StrategyHealthEvaluation['status'] = 'HEALTHY_EDGE';
    let actionRecommendation = 'Strategi memiliki positive expectancy valid. Pertahankan alokasi modal normal.';

    if (metrics.expectancyR < -0.15 || metrics.profitFactor < 0.8) {
      status = 'DEFENSIVE_MODE_REQUIRED';
      actionRecommendation = '🚨 ALPHA DECAY KRITIS: Turunkan sizing ke 25% atau jeda entri strategi baru. Lakukan recalibration parameter out-of-sample.';
    } else if (metrics.expectancyR <= 0 || metrics.profitFactor < 1.1) {
      status = 'DEGRADING_EDGE';
      actionRecommendation = '⚠️ EDGE MELEMAH: Terapkan pengetatan stop-loss dan kurangi toleransi drift entry.';
    }

    return {
      status,
      expectancy: metrics,
      actionRecommendation,
      diagnostics
    };
  }
}
