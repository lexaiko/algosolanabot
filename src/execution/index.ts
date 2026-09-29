export * from './opportunityScorer';
export * from './entryEngine';
// M4 (2026-09-29): executionEngine.ts DELETED — dead module with fabricated fills
// (fake slot, fixed "randomized" slippage, executeLiveOnChain silently returning
// paper fills). No callers existed; only the re-export referenced it.
export * from './positionManager';
