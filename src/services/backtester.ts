import axios from 'axios';
import { CONFIG } from '../config';
import { calculateComprehensiveQuantMetrics, QuantMetricsResult } from './quantMetrics';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestTrade {
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  sizeSol: number;
  grossPnlSol: number;
  feesSol: number;
  netPnlSol: number;
  pnlPct: number;
  exitReason: string;
}

export interface BacktestReport {
  tokenIdentifier: string;
  candleCount: number;
  timeframe: string;
  initialBalanceSol: number;
  finalBalanceSol: number;
  trades: BacktestTrade[];
  metrics: QuantMetricsResult;
}

/**
 * Fetches real on-chain candles from GeckoTerminal via DexScreener Solana pair routing.
 */
export async function fetchHistoricalCandles(
  tokenMintOrPair: string,
  timeframe: 'minute' | 'hour' | 'day' = 'hour',
  limit: number = 50
): Promise<{ candles: Candle[]; pairAddress: string; tokenSymbol: string }> {
  let pairAddress = tokenMintOrPair;
  let tokenSymbol = 'TOKEN';

  try {
    // If input is a token mint, look up best pair address via DexScreener
    if (tokenMintOrPair.length >= 32) {
      const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMintOrPair}`, {
        timeout: 6000
      });
      const pairs = dexRes.data?.pairs?.filter((p: any) => p.chainId === 'solana');
      if (pairs && pairs.length > 0) {
        pairAddress = pairs[0].pairAddress;
        tokenSymbol = pairs[0].baseToken?.symbol || 'TOKEN';
      }
    }

    const geckoRes = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/${timeframe}?limit=${limit}`,
      { headers: { Accept: 'application/json' }, timeout: 7000 }
    );

    const rawList = geckoRes.data?.data?.attributes?.ohlcv_list || [];
    // GeckoTerminal returns [time, open, high, low, close, volume] ordered newest first
    const candles: Candle[] = rawList
      .map((item: any) => ({
        timestamp: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5])
      }))
      .sort((a: Candle, b: Candle) => a.timestamp - b.timestamp); // Chronological order

    return { candles, pairAddress, tokenSymbol };
  } catch (err: any) {
    console.error('[Backtester] Error fetching historical candles:', err.message);
    return { candles: [], pairAddress, tokenSymbol };
  }
}

/**
 * Generates synthetic realistic market regime candle datasets for stress-testing.
 */
export function generateSyntheticRegime(
  regime: 'BULL' | 'CHOP' | 'BLOODBATH' | 'PUMP_DUMP',
  candleCount: number = 60
): { candles: Candle[]; tokenSymbol: string } {
  const candles: Candle[] = [];
  let price = 0.001; // Base starting price
  const now = Math.floor(Date.now() / 1000);
  const stepSec = 300; // 5-minute bars

  for (let i = 0; i < candleCount; i++) {
    const ts = now - (candleCount - i) * stepSec;
    let changePct = 0;

    switch (regime) {
      case 'BULL':
        // Steady upward bias (+1.5% avg, with pullbacks)
        changePct = (Math.random() * 5.0) - 1.5;
        break;
      case 'CHOP':
        // Oscillating mean reversion (-3% to +3%)
        changePct = (Math.random() * 6.0) - 3.0;
        break;
      case 'BLOODBATH':
        // Severe downward cascade (-4% avg, occasional dead cat)
        changePct = (Math.random() * 4.0) - 5.5;
        break;
      case 'PUMP_DUMP':
        // Phase 1: 0..25 pump (+6% avg), Phase 2: 25..60 brutal dump (-10% avg)
        if (i < 25) {
          changePct = (Math.random() * 8.0) - 1.0;
        } else {
          changePct = (Math.random() * 4.0) - 9.0;
        }
        break;
    }

    const open = price;
    const close = Math.max(0.000001, open * (1 + changePct / 100));
    const high = Math.max(open, close) * (1 + (Math.random() * 1.5) / 100);
    const low = Math.min(open, close) * (1 - (Math.random() * 1.5) / 100);
    const volume = 10000 + Math.random() * 50000;

    candles.push({ timestamp: ts, open, high, low, close, volume });
    price = close;
  }

  const symbolMap = {
    BULL: 'SYNTH-BULL',
    CHOP: 'SYNTH-CHOP',
    BLOODBATH: 'SYNTH-CRASH',
    PUMP_DUMP: 'SYNTH-RUG'
  };

  return { candles, tokenSymbol: symbolMap[regime] };
}

/**
 * Executes historical backtest simulation replicating live bot quant rules.
 */
export function runBacktest(
  candles: Candle[],
  tokenSymbol: string = 'TOKEN',
  initialBalanceSol: number = 10.0,
  tradeSizeSol: number = CONFIG.DEFAULT_BUY_AMOUNT_SOL
): BacktestReport {
  if (!candles || candles.length < 5) {
    return {
      tokenIdentifier: tokenSymbol,
      candleCount: candles?.length || 0,
      timeframe: '5m/1h',
      initialBalanceSol,
      finalBalanceSol: initialBalanceSol,
      trades: [],
      metrics: calculateComprehensiveQuantMetrics([], initialBalanceSol)
    };
  }

  let currentBalance = initialBalanceSol;
  const trades: BacktestTrade[] = [];

  let activePosition: {
    entryTimestamp: number;
    entryPrice: number;
    sizeSol: number;
    peakPrice: number;
    targetTpPct: number;
    targetSlPct: number;
    isHalfClosed: boolean;
    remainingTokens: number;
  } | null = null;

  for (let i = 2; i < candles.length; i++) {
    const candle = candles[i];
    const prevCandle = candles[i - 1];

    // 1. MANAGE OPEN POSITION
    if (activePosition) {
      activePosition.peakPrice = Math.max(activePosition.peakPrice, candle.high);
      const curReturnPct = ((candle.close - activePosition.entryPrice) / activePosition.entryPrice) * 100;
      const peakReturnPct = ((activePosition.peakPrice - activePosition.entryPrice) / activePosition.entryPrice) * 100;
      const dropFromPeakPct = ((activePosition.peakPrice - candle.low) / activePosition.peakPrice) * 100;

      let exitReason = '';
      let exitPrice = candle.close;
      let shouldExitFull = false;

      // Condition A: Flash-Exit Rug Buster (>30% drop in single bar)
      const barDropPct = ((candle.open - candle.low) / candle.open) * 100;
      if (barDropPct >= CONFIG.FLASH_EXIT_DROP_PCT) {
        exitReason = 'FLASH_EXIT_RUG_BUSTER';
        exitPrice = candle.low;
        shouldExitFull = true;
      }
      // Condition B: Stop Loss triggered
      else if (candle.low <= activePosition.entryPrice * (1 - activePosition.targetSlPct / 100)) {
        exitReason = `STOP_LOSS (-${activePosition.targetSlPct}%)`;
        exitPrice = activePosition.entryPrice * (1 - activePosition.targetSlPct / 100);
        shouldExitFull = true;
      }
      // Condition C: Stage 1 Take-Profit (50% exit)
      else if (!activePosition.isHalfClosed && candle.high >= activePosition.entryPrice * (1 + activePosition.targetTpPct / 100)) {
        activePosition.isHalfClosed = true;
        const halfSize = activePosition.sizeSol / 2;
        const halfExitSol = halfSize * (1 + activePosition.targetTpPct / 100);
        const grossPnl = halfExitSol - halfSize;
        const fees = CONFIG.ESTIMATED_BUY_FEE_SOL / 2 + CONFIG.ESTIMATED_SELL_FEE_SOL;
        const netPnl = grossPnl - fees;

        currentBalance += halfExitSol - fees;
        trades.push({
          entryTimestamp: activePosition.entryTimestamp,
          exitTimestamp: candle.timestamp,
          entryPrice: activePosition.entryPrice,
          exitPrice: activePosition.entryPrice * (1 + activePosition.targetTpPct / 100),
          sizeSol: halfSize,
          grossPnlSol: Number(grossPnl.toFixed(4)),
          feesSol: Number(fees.toFixed(4)),
          netPnlSol: Number(netPnl.toFixed(4)),
          pnlPct: activePosition.targetTpPct,
          exitReason: `STAGE1_TP_50% (+${activePosition.targetTpPct}%)`
        });
        activePosition.sizeSol = halfSize; // remaining 50%
      }
      // Condition D: Trailing Stop for Moonbag (12% drop from peak after TP1)
      else if (activePosition.isHalfClosed && dropFromPeakPct >= CONFIG.TRAILING_STOP_PCT) {
        exitReason = `TRAILING_STOP_MOONBAG (-${CONFIG.TRAILING_STOP_PCT}% from peak)`;
        exitPrice = activePosition.peakPrice * (1 - CONFIG.TRAILING_STOP_PCT / 100);
        shouldExitFull = true;
      }

      if (shouldExitFull) {
        const exitMultiplier = exitPrice / activePosition.entryPrice;
        const exitSol = activePosition.sizeSol * exitMultiplier;
        const grossPnl = exitSol - activePosition.sizeSol;
        const sellFee = CONFIG.ESTIMATED_SELL_FEE_SOL;
        const buyFee = activePosition.isHalfClosed ? 0 : CONFIG.ESTIMATED_BUY_FEE_SOL;
        const totalFees = buyFee + sellFee;
        const netPnl = grossPnl - totalFees;
        const pnlPct = ((exitPrice - activePosition.entryPrice) / activePosition.entryPrice) * 100;

        currentBalance += exitSol - sellFee;
        trades.push({
          entryTimestamp: activePosition.entryTimestamp,
          exitTimestamp: candle.timestamp,
          entryPrice: activePosition.entryPrice,
          exitPrice,
          sizeSol: activePosition.sizeSol,
          grossPnlSol: Number(grossPnl.toFixed(4)),
          feesSol: Number(totalFees.toFixed(4)),
          netPnlSol: Number(netPnl.toFixed(4)),
          pnlPct: Number(pnlPct.toFixed(2)),
          exitReason
        });

        activePosition = null;
      }
    }

    // 2. ENTRY SIGNAL EVALUATION
    // Simulated Smart Money buy signal on breakout candle
    if (!activePosition && currentBalance >= tradeSizeSol + CONFIG.ESTIMATED_BUY_FEE_SOL) {
      const prevBarChangePct = ((prevCandle.close - prevCandle.open) / prevCandle.open) * 100;
      const curBarChangePct = ((candle.open - prevCandle.close) / prevCandle.close) * 100;

      // Anti-Chase Guard (+6% drift ceiling)
      if (curBarChangePct > CONFIG.MAX_PRICE_DRIFT_PCT) {
        // Skipped: Anti-Chase Guard triggered
        continue;
      }

      // Signal: Positive momentum breakout (> 2.5% bar jump)
      if (prevBarChangePct > 2.5 && candle.volume > prevCandle.volume) {
        const buyFee = CONFIG.ESTIMATED_BUY_FEE_SOL;
        currentBalance -= (tradeSizeSol + buyFee);

        // Volatility adaptive bands
        const targetTpPct = CONFIG.VOLATILITY_ADAPTIVE_EXITS ? 50.0 : CONFIG.TAKE_PROFIT_PCT;
        const targetSlPct = CONFIG.VOLATILITY_ADAPTIVE_EXITS ? 25.0 : CONFIG.STOP_LOSS_PCT;

        activePosition = {
          entryTimestamp: candle.timestamp,
          entryPrice: candle.open,
          sizeSol: tradeSizeSol,
          peakPrice: candle.open,
          targetTpPct,
          targetSlPct,
          isHalfClosed: false,
          remainingTokens: tradeSizeSol / candle.open
        };
      }
    }
  }

  // Force close remaining open position at backtest end
  if (activePosition) {
    const lastCandle = candles[candles.length - 1];
    const exitMultiplier = lastCandle.close / activePosition.entryPrice;
    const exitSol = activePosition.sizeSol * exitMultiplier;
    const grossPnl = exitSol - activePosition.sizeSol;
    const fees = CONFIG.ESTIMATED_SELL_FEE_SOL;
    const netPnl = grossPnl - fees;
    const pnlPct = ((lastCandle.close - activePosition.entryPrice) / activePosition.entryPrice) * 100;

    currentBalance += exitSol - fees;
    trades.push({
      entryTimestamp: activePosition.entryTimestamp,
      exitTimestamp: lastCandle.timestamp,
      entryPrice: activePosition.entryPrice,
      exitPrice: lastCandle.close,
      sizeSol: activePosition.sizeSol,
      grossPnlSol: Number(grossPnl.toFixed(4)),
      feesSol: Number(fees.toFixed(4)),
      netPnlSol: Number(netPnl.toFixed(4)),
      pnlPct: Number(pnlPct.toFixed(2)),
      exitReason: 'END_OF_BACKTEST'
    });
  }

  const tradeMetricsInput = trades.map(t => ({
    pnlSol: t.grossPnlSol,
    pnlPct: t.pnlPct,
    feeSol: t.feesSol
  }));

  const metrics = calculateComprehensiveQuantMetrics(tradeMetricsInput, initialBalanceSol);

  return {
    tokenIdentifier: tokenSymbol,
    candleCount: candles.length,
    timeframe: 'OHLCV Replay',
    initialBalanceSol,
    finalBalanceSol: Number(currentBalance.toFixed(4)),
    trades,
    metrics
  };
}

/**
 * Formats backtest results into an institutional Telegram markdown report.
 */
export function formatBacktestTelegramReport(report: BacktestReport): string {
  const m = report.metrics;
  const isProfit = m.netPnlSol >= 0;
  const netReturnPct = ((report.finalBalanceSol - report.initialBalanceSol) / report.initialBalanceSol) * 100;

  let text = `🔬 *INSTITUTIONAL QUANT BACKTEST REPORT*\n\n` +
    `🪙 *Aset / Skenario:* *${report.tokenIdentifier}*\n` +
    `📊 *Total Candle Diuji:* *${report.candleCount} bars*\n` +
    `💰 *Modal Awal:* ${report.initialBalanceSol} SOL ➔ *${report.finalBalanceSol} SOL* (${netReturnPct >= 0 ? '+' : ''}${netReturnPct.toFixed(2)}%)\n\n` +
    `📈 *Rasio Kinerja & Manajemen Risiko:*\n` +
    `• Sharpe Ratio: *${m.sharpeRatio}* ${m.sharpeRatio >= 1.5 ? '🏆 (Elite)' : (m.sharpeRatio >= 1.0 ? '✅ (Sehat)' : '⚠️')}\n` +
    `• Sortino Ratio: *${m.sortinoRatio}* (Downside Volatility Adjusted)\n` +
    `• Profit Factor: *${m.profitFactor}* ${m.profitFactor >= 1.75 ? '🟢 (Prima)' : '🔻'}\n` +
    `• Max Drawdown (MDD): *${m.maxDrawdownPct}%* (-${m.maxDrawdownSol.toFixed(4)} SOL)\n` +
    `• Calmar Ratio: *${m.calmarRatio}*\n` +
    `• Payoff Ratio: *${m.payoffRatio}x* (Avg Win / Avg Loss)\n` +
    `• Ekspektasi Matematis: *${m.tradeExpectancySol >= 0 ? '+' : ''}${m.tradeExpectancySol.toFixed(4)} SOL / trade*\n\n` +
    `💵 *Akuntansi Real (True Net Accounting):*\n` +
    `• Gross Laba Kotor: *${m.grossPnlSol >= 0 ? '+' : ''}${m.grossPnlSol.toFixed(4)} SOL*\n` +
    `• Beban Gas Drag: *-${m.totalFeesSol.toFixed(4)} SOL* (Priority + Jito)\n` +
    `• 🎯 *Net Realized PnL:* *${m.netPnlSol >= 0 ? '+' : ''}${m.netPnlSol.toFixed(4)} SOL* ${isProfit ? '💰' : '🔻'}\n` +
    `• Total Trade Selesai: *${m.totalTrades}* (Win Rate: *${m.winRatePct}%* - ${m.winTrades}W / ${m.lossTrades}L)\n\n`;

  if (report.trades.length > 0) {
    text += `📋 *Daftar Trade Simulasi (Terakhir):*\n`;
    const recentTrades = report.trades.slice(-4);
    for (const t of recentTrades) {
      const isWin = t.pnlPct >= 0;
      text += `• ${isWin ? '🟢' : '🔴'} *${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%* (${t.netPnlSol >= 0 ? '+' : ''}${t.netPnlSol.toFixed(4)} SOL) - \`${t.exitReason}\`\n`;
    }
  }

  return text;
}
