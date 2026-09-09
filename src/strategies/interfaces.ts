import { FeatureVector, StrategySignal } from '../core/types';

export interface IStrategy {
  id: string;
  name: string;
  version: string;
  description: string;
  evaluate(features: FeatureVector): StrategySignal | null;
}
