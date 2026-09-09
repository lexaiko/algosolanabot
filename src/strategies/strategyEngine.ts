import { IStrategy } from './interfaces';
import { FeatureVector, StrategySignal } from '../core/types';
import { MomentumContinuationStrategy } from './momentumStrategy';
import { StructuralBreakoutStrategy } from './breakoutStrategy';
import { OrderFlowImbalanceStrategy } from './flowImbalanceStrategy';
import { WhaleConfirmationStrategy } from './whaleConfirmationStrategy';

export class StrategyEngine {
  private strategies: Map<string, IStrategy> = new Map();

  constructor() {
    this.registerStrategy(new MomentumContinuationStrategy());
    this.registerStrategy(new StructuralBreakoutStrategy());
    this.registerStrategy(new OrderFlowImbalanceStrategy());
    this.registerStrategy(new WhaleConfirmationStrategy());
  }

  public registerStrategy(strategy: IStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }

  public getStrategies(): IStrategy[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Evaluates feature vector across all registered strategies
   */
  public evaluateFeatures(features: FeatureVector): StrategySignal[] {
    const signals: StrategySignal[] = [];

    for (const strategy of this.strategies.values()) {
      try {
        const sig = strategy.evaluate(features);
        if (sig) signals.push(sig);
      } catch (err: any) {
        console.error(`[StrategyEngine] Error evaluating strategy ${strategy.id}:`, err.message);
      }
    }

    return signals;
  }
}

export const strategyEngine = new StrategyEngine();
