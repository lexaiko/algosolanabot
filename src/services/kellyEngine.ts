import { CONFIG } from '../config';
import { Whale } from '../types/index';

export interface KellySizingResult {
  allocatedSol: number;
  kellyFraction: number;
  rawKelly: number;
  liquidityCapSol: number;
  rationale: string;
}

/**
 * Institutional Quantitative Capital Allocation via Fractional Kelly Criterion
 * Formula: f* = (p * b - q) / b
 * where:
 *   p = Probability of winning trade (derived from whale & portfolio track record)
 *   q = Probability of losing trade (1 - p)
 *   b = Odds / Payoff Ratio (Avg Win % / Avg Loss %)
 */
export function calculateKellyPositionSize(
  whale: Whale,
  poolLiquidityUsd: number,
  solPriceUsd: number,
  portfolioBalanceSol: number,
  volatility5mPct: number = 0
): KellySizingResult {
  if (!CONFIG.KELLY_SIZING_ENABLED) {
    const fixed = whale.tier === 'VIP' ? CONFIG.VIP_BUY_AMOUNT_SOL : CONFIG.DEFAULT_BUY_AMOUNT_SOL;
    return {
      allocatedSol: fixed,
      kellyFraction: 0,
      rawKelly: 0,
      liquidityCapSol: 999,
      rationale: 'Kelly Sizing disabled, using fixed tier allocation.'
    };
  }

  // 1. Determine Win Rate (p) dynamically based on real performance
  let winRate = 0.52; // Neutral baseline
  if (whale.total_trades_copied && whale.total_trades_copied >= 2 && whale.win_rate !== undefined) {
    winRate = Math.min(Math.max(whale.win_rate / 100, 0.35), 0.85); // bounded 35% - 85%
  } else if (whale.tier === 'VIP') {
    winRate = 0.58;
  } else if (whale.tier === 'VERIFIED') {
    winRate = 0.54;
  }

  // Consecutive loss dampener: if whale has consecutive losses, dynamically lower conviction
  if (whale.consecutive_losses && whale.consecutive_losses > 0) {
    winRate = Math.max(0.35, winRate - (whale.consecutive_losses * 0.08));
  }

  const p = winRate;
  const q = 1 - p;

  // 2. Payoff Ratio (b) - Target TP (+35%) vs Hard SL (-12%) = ~2.9x asymmetric payoff!
  const avgWinPct = CONFIG.TAKE_PROFIT_PCT || 35.0;
  const avgLossPct = CONFIG.STOP_LOSS_PCT || 12.0;
  const b = Math.max(1.2, avgWinPct / avgLossPct);

  // 3. Raw Kelly Criterion: f* = (p * b - q) / b
  const rawKelly = (p * b - q) / b;

  // If edge is negative, allocate minimal testing size
  if (rawKelly <= 0) {
    return {
      allocatedSol: 0.03,
      kellyFraction: 0,
      rawKelly,
      liquidityCapSol: 0.03,
      rationale: `Negative Kelly edge (${(rawKelly * 100).toFixed(1)}%). Minimal testing size 0.03 SOL.`
    };
  }

  // 4. Fractional Quarter-Kelly for institutional drawdown suppression
  const fractionalKelly = rawKelly * CONFIG.KELLY_FRACTION;
  const kellySol = portfolioBalanceSol * fractionalKelly;

  // 5. Dynamic Portfolio Capital Exposure Cap (Adaptive 2.5% - 3.5% of current equity)
  // Scales up when portfolio grows, and scales down automatically when balance shrinks
  const maxExposurePct = whale.tier === 'VIP' ? 0.035 : 0.025;
  const dynamicExposureCap = portfolioBalanceSol * maxExposurePct;

  // 6. Institutional Risk Budgeting Cap (Max 1.5% portfolio equity at risk per trade)
  // CapitalAtRisk = PositionSize * (SL% / 100) <= Balance * 0.015
  const dynamicRiskBudgetSol = (portfolioBalanceSol * 0.015) / (avgLossPct / 100);

  // 7. Liquidity-Depth Cap: Never exceed 1.0% of total pool depth
  const maxPoolDepthUsd = poolLiquidityUsd * 0.01;
  const liquidityCapSol = solPriceUsd > 0 ? maxPoolDepthUsd / solPriceUsd : 0.10;

  // 8. Continuous Conditional Volatility Decay Curve
  // As 5m volatility increases above 5%, smoothly scale down size to protect against violent dumps
  const absVol = Math.abs(volatility5mPct);
  const volMultiplier = absVol <= 5.0
    ? 1.0
    : Math.max(0.40, 1.0 - ((absVol - 5.0) / 35.0));

  // 9. Dynamic Whale Streak Multiplier: exponential decay on losing streaks (0.75^losses)
  const streakMultiplier = whale.consecutive_losses && whale.consecutive_losses > 0
    ? Math.pow(0.75, whale.consecutive_losses)
    : 1.0;

  const floorSol = Math.max(0.03, Math.min(0.05, portfolioBalanceSol * 0.01)); // Minimum viable order on Solana

  // Base allocation bounded by Kelly, Risk Budget, Dynamic Exposure Cap, and Pool Liquidity
  const baseAllocation = Math.min(kellySol, dynamicRiskBudgetSol, dynamicExposureCap, liquidityCapSol);
  let finalAllocation = baseAllocation * volMultiplier * streakMultiplier;
  finalAllocation = Math.max(finalAllocation, floorSol);
  finalAllocation = Math.round(finalAllocation * 1000) / 1000;

  return {
    allocatedSol: finalAllocation,
    kellyFraction: fractionalKelly,
    rawKelly,
    liquidityCapSol,
    rationale: `Balance: ${portfolioBalanceSol.toFixed(2)} SOL | Dynamic Cap: ${dynamicExposureCap.toFixed(3)} SOL (${(maxExposurePct * 100).toFixed(1)}%) | Vol Decay: ${volMultiplier.toFixed(2)}x | Streak Decay: ${streakMultiplier.toFixed(2)}x | Kelly: ${(fractionalKelly * 100).toFixed(1)}%`
  };
}
