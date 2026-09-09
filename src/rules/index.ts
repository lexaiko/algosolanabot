// Public API for the Advanced Quantitative Rule Engine
export * from './types';
export * from './engine';

// Safety Rules
export { AntiRugRule } from './safety/antiRugRule';
export { LiquidityFloorRule } from './safety/liquidityFloorRule';
export { VolumeFloorRule } from './safety/volumeFloorRule';

// Microstructure Rules
export { CabalClusterRule } from './microstructure/cabalClusterRule';
export { AntiChaseRule } from './microstructure/antiChaseRule';
export { AntiFomoSpikeRule } from './microstructure/antiFomoSpikeRule';
export { BondingCurveRule } from './microstructure/bondingCurveRule';

// Risk & Sizing Rules
export { PortfolioExposureRule } from './risk/portfolioExposureRule';
export { NarrativeLimitRule, parseTokenNarrative } from './risk/narrativeLimitRule';
export { DynamicKellySizingRule } from './risk/dynamicKellySizing';

// Exit Rules
export { FlashExitShieldRule } from './exit/flashExitShield';
export { WhaleDumpRule } from './exit/whaleDumpRule';
export { DynamicTrailingStopRule } from './exit/dynamicTrailingStop';
export { TimeDecayExitRule } from './exit/timeDecayExitRule';
