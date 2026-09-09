/**
 * INSTITUTIONAL QUANTITATIVE METRICS ENGINE
 * Implements standard hedge fund statistical risk & performance indicators.
 */

export interface QuantMetricsResult {
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRatePct: number;
  grossPnlSol: number;
  totalFeesSol: number;
  netPnlSol: number;
  sharpeRatio: number;
  sortinoRatio: number;
  profitFactor: number;
  maxDrawdownPct: number;
  maxDrawdownSol: number;
  calmarRatio: number;
  avgWinSol: number;
  avgLossSol: number;
  payoffRatio: number;
  tradeExpectancySol: number;
}

/**
 * Calculates standard Sharpe Ratio:
 * S = (E[R] - Rf) / StdDev(R)
 * In high-frequency / crypto, returns are evaluated on per-trade or daily frequency.
 */
export function calculateSharpeRatio(returns: number[], riskFreePerTrade: number = 0): number {
  if (!returns || returns.length < 2) return 0;

  const n = returns.length;
  const mean = returns.reduce((acc, r) => acc + r, 0) / n;
  const excessMean = mean - riskFreePerTrade;

  const variance = returns.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return excessMean > 0 ? 9.99 : 0;
  return Number((excessMean / stdDev).toFixed(2));
}

/**
 * Calculates Sortino Ratio:
 * S = (E[R] - Target) / DownsideDev(R)
 * Only penalizes returns below the target (downside volatility), preserving positive volatility.
 */
export function calculateSortinoRatio(returns: number[], targetReturn: number = 0): number {
  if (!returns || returns.length < 2) return 0;

  const n = returns.length;
  const mean = returns.reduce((acc, r) => acc + r, 0) / n;
  const excessMean = mean - targetReturn;

  const downsideDifferences = returns
    .filter(r => r < targetReturn)
    .map(r => Math.pow(r - targetReturn, 2));

  if (downsideDifferences.length === 0) {
    return excessMean > 0 ? 9.99 : 0; // Zero downside variance
  }

  const downsideVariance = downsideDifferences.reduce((acc, d) => acc + d, 0) / n;
  const downsideDev = Math.sqrt(downsideVariance);

  if (downsideDev === 0) return excessMean > 0 ? 9.99 : 0;
  return Number((excessMean / downsideDev).toFixed(2));
}

/**
 * Calculates Profit Factor:
 * PF = Gross Profits / |Gross Losses|
 */
export function calculateProfitFactor(pnlList: number[]): number {
  if (!pnlList || pnlList.length === 0) return 0;

  const grossProfit = pnlList.filter(p => p > 0).reduce((acc, p) => acc + p, 0);
  const grossLoss = Math.abs(pnlList.filter(p => p < 0).reduce((acc, p) => acc + p, 0));

  if (grossLoss === 0) {
    return grossProfit > 0 ? 99.9 : 0;
  }

  return Number((grossProfit / grossLoss).toFixed(2));
}

/**
 * Calculates Maximum Drawdown (MDD) from an equity trajectory:
 * MDD = max((Peak - Trough) / Peak)
 */
export function calculateMaxDrawdown(equityCurve: number[]): {
  mddPct: number;
  mddAmount: number;
  peakIndex: number;
  troughIndex: number;
} {
  if (!equityCurve || equityCurve.length < 2) {
    return { mddPct: 0, mddAmount: 0, peakIndex: 0, troughIndex: 0 };
  }

  let peak = equityCurve[0];
  let peakIdx = 0;
  let maxDdPct = 0;
  let maxDdAmount = 0;
  let bestPeakIdx = 0;
  let bestTroughIdx = 0;

  for (let i = 1; i < equityCurve.length; i++) {
    const val = equityCurve[i];
    if (val > peak) {
      peak = val;
      peakIdx = i;
    } else {
      const ddAmount = peak - val;
      const ddPct = peak > 0 ? (ddAmount / peak) * 100 : 0;
      if (ddPct > maxDdPct) {
        maxDdPct = ddPct;
        maxDdAmount = ddAmount;
        bestPeakIdx = peakIdx;
        bestTroughIdx = i;
      }
    }
  }

  return {
    mddPct: Number(maxDdPct.toFixed(2)),
    mddAmount: Number(maxDdAmount.toFixed(4)),
    peakIndex: bestPeakIdx,
    troughIndex: bestTroughIdx
  };
}

/**
 * Aggregates all institutional quantitative metrics from trade records.
 */
export function calculateComprehensiveQuantMetrics(
  trades: Array<{ pnlSol: number; pnlPct: number; feeSol?: number }>,
  initialCapitalSol: number = 10.0
): QuantMetricsResult {
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      winTrades: 0,
      lossTrades: 0,
      winRatePct: 0,
      grossPnlSol: 0,
      totalFeesSol: 0,
      netPnlSol: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      profitFactor: 0,
      maxDrawdownPct: 0,
      maxDrawdownSol: 0,
      calmarRatio: 0,
      avgWinSol: 0,
      avgLossSol: 0,
      payoffRatio: 0,
      tradeExpectancySol: 0
    };
  }

  const winTradesList = trades.filter(t => t.pnlSol > 0);
  const lossTradesList = trades.filter(t => t.pnlSol <= 0);

  const winTrades = winTradesList.length;
  const lossTrades = lossTradesList.length;
  const winRatePct = Number(((winTrades / totalTrades) * 100).toFixed(1));

  const grossPnlSol = Number(trades.reduce((acc, t) => acc + t.pnlSol, 0).toFixed(4));
  const totalFeesSol = Number(trades.reduce((acc, t) => acc + (t.feeSol || 0), 0).toFixed(4));
  const netPnlSol = Number((grossPnlSol - totalFeesSol).toFixed(4));

  const returnPctList = trades.map(t => t.pnlPct);
  const pnlSolList = trades.map(t => t.pnlSol);

  const sharpeRatio = calculateSharpeRatio(returnPctList);
  const sortinoRatio = calculateSortinoRatio(returnPctList);
  const profitFactor = calculateProfitFactor(pnlSolList);

  // Construct equity curve
  let currentEquity = initialCapitalSol;
  const equityCurve: number[] = [initialCapitalSol];
  for (const t of trades) {
    currentEquity += (t.pnlSol - (t.feeSol || 0));
    equityCurve.push(currentEquity);
  }

  const mdd = calculateMaxDrawdown(equityCurve);

  // Calmar Ratio: Total Net Return % / Max Drawdown %
  const totalReturnPct = (netPnlSol / initialCapitalSol) * 100;
  const calmarRatio = mdd.mddPct > 0 ? Number((totalReturnPct / mdd.mddPct).toFixed(2)) : 0;

  // Payoff and Expectancy
  const sumWins = winTradesList.reduce((acc, t) => acc + t.pnlSol, 0);
  const sumLosses = Math.abs(lossTradesList.reduce((acc, t) => acc + t.pnlSol, 0));

  const avgWinSol = winTrades > 0 ? Number((sumWins / winTrades).toFixed(4)) : 0;
  const avgLossSol = lossTrades > 0 ? Number((sumLosses / lossTrades).toFixed(4)) : 0;

  const payoffRatio = avgLossSol > 0 ? Number((avgWinSol / avgLossSol).toFixed(2)) : (avgWinSol > 0 ? 99.9 : 0);

  const winProb = winTrades / totalTrades;
  const lossProb = lossTrades / totalTrades;
  const tradeExpectancySol = Number(((winProb * avgWinSol) - (lossProb * avgLossSol)).toFixed(4));

  return {
    totalTrades,
    winTrades,
    lossTrades,
    winRatePct,
    grossPnlSol,
    totalFeesSol,
    netPnlSol,
    sharpeRatio,
    sortinoRatio,
    profitFactor,
    maxDrawdownPct: mdd.mddPct,
    maxDrawdownSol: mdd.mddAmount,
    calmarRatio,
    avgWinSol,
    avgLossSol,
    payoffRatio,
    tradeExpectancySol
  };
}
