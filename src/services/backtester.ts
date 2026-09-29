import axios from 'axios';
import { CONFIG } from '../config';
import { calculateComprehensiveQuantMetrics, QuantMetricsResult } from './quantMetrics';
import { PositionManager } from '../execution/positionManager';
import { PositionRecord } from '../core/types';

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
  /** Honest metadata: what this backtest is and is NOT. Rendered in the report. */
  assumptions: string[];
}

export interface BacktestOptions {
  /** Venue for the fee model (pump 1.25%/side vs Raydium 0.25%/side). Default true. */
  isPump?: boolean;
  /** SOL/USD for notional accounting. Default 180. */
  solPriceUsd?: number;
  /** Adverse fill slippage applied to every exit (%). Default CONFIG.SLIPPAGE_PCT. */
  slippagePct?: number;
  /**
   * Synthetic entry signal variant (NOT the production scorer/gates):
   * - 'baseline': 1-bar momentum (prevBar > +2.5% + rising volume), full size.
   * - 'continuation3': 3 consecutive rising closes, each with rising volume
   *   (mimics MOMENTUM_CONTINUATION's 3x higher-high confirmation), HALF size.
   * Default 'baseline'.
   */
  entrySignal?: 'baseline' | 'continuation3';
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

const EMERGENCY_RULES = new Set(['FLASH_LIQUIDITY_DRAIN', 'VELOCITY_DUMP_RESCUE', 'HARD_STOP_LOSS']);

/**
 * C-1 (2026-09-29): REWRITTEN. The old runBacktest simulated the RETIRED
 * Half-TP/moonbag strategy with a fee model that ignored DEX fees entirely
 * (~3-7x understated costs) — every number it produced was fiction for a
 * strategy the bot does not run.
 *
 * The new engine drives exits through PositionManager.evaluatePositionExit —
 * the SAME mirror module that tracks production's evaluatePosition
 * (100% single-exit dynamic ratchet, continuous net-of-fees floors, adaptive
 * trailing, zombie reaper v2, max-hold). Fees are venue-aware
 * (pump 1.25%/side vs Raydium 0.25%/side) + live network estimates, and every
 * exit fill takes adverse slippage.
 *
 * What it is NOT (read before quoting any number):
 * - Entries use a SYNTHETIC breakout signal, not the production scorer/gates.
 * - Per-BAR granularity: no intrabar tick dynamics. Intrabar order is assumed
 *   ADVERSE (low evaluated before high) — conservative by design.
 * - No Jupiter routing, no per-bar liquidity data: the flash-liquidity exit
 *   cannot trigger here (no depth series), so rug scenarios are UNDERSTATED.
 * - Velocity-dump detection is coarse at bar resolution vs production ticks.
 */
export function runBacktest(
  candles: Candle[],
  tokenSymbol: string = 'TOKEN',
  initialBalanceSol: number = 10.0,
  tradeSizeSol: number = CONFIG.DEFAULT_BUY_AMOUNT_SOL,
  options: BacktestOptions = {}
): BacktestReport {
  const isPump = options.isPump !== false;
  const solPriceUsd = options.solPriceUsd && options.solPriceUsd > 0 ? options.solPriceUsd : 180;
  const slippagePct = options.slippagePct && options.slippagePct > 0 ? options.slippagePct : CONFIG.SLIPPAGE_PCT;
  const dexFeePct = isPump ? 1.25 : 0.25;
  const entrySignal = options.entrySignal || 'baseline';
  // continuation3 entries run at half size, mirroring the production rule that
  // MOMENTUM_CONTINUATION buys a worse average entry (top of rally) than dips.
  const entrySizeSol = entrySignal === 'continuation3' ? tradeSizeSol * 0.5 : tradeSizeSol;
  const networkBuyFeeSol = CONFIG.ESTIMATED_BUY_FEE_SOL || 0.00035;
  const networkSellFeeSol = CONFIG.ESTIMATED_SELL_FEE_SOL || 0.00025;

  const assumptions = [
    `Exit engine: production mirror (PositionManager.evaluatePositionExit) — 100% single-exit dynamic ratchet, continuous net-of-fees floors, zombie v2, max-hold ${CONFIG.MAX_HOLD_TIME_HOURS}h`,
    `Fees: venue-aware (${isPump ? 'pump.fun 1.25%/side' : 'Raydium 0.25%/side'}) + network ~${(networkBuyFeeSol + networkSellFeeSol).toFixed(5)} SOL round-trip — charged on BOTH legs`,
    `Fills: every exit filled ADVERSE at trigger price minus ${slippagePct}% slippage (emergency exits: ${Math.max(8, slippagePct * 2.5)}%)`,
    `Entries: SYNTHETIC ${entrySignal === 'continuation3' ? 'continuation signal (3 rising closes + rising volume, HALF size — mirror of MOMENTUM_CONTINUATION)' : 'breakout signal (momentum bar + rising volume + anti-chase, full size)'} — NOT the production scorer/gates`,
    `Granularity: per-bar; intrabar order assumed adverse (low before high); no Jupiter routing; no per-bar liquidity data so flash-liquidity exits cannot trigger (rug losses understated)`,
  ];

  if (!candles || candles.length < 5) {
    return {
      tokenIdentifier: tokenSymbol,
      candleCount: candles?.length || 0,
      timeframe: '5m/1h',
      initialBalanceSol,
      finalBalanceSol: initialBalanceSol,
      trades: [],
      metrics: calculateComprehensiveQuantMetrics([], initialBalanceSol),
      assumptions,
    };
  }

  let currentBalance = initialBalanceSol;
  const trades: BacktestTrade[] = [];
  const pm = new PositionManager();

  let activePosition: PositionRecord | null = null;
  let activeSizeSol = 0;
  let activeBuyFeeSol = 0;
  let activeEntryTs = 0;

  const closeActive = (
    exitBarTs: number,
    triggerPriceUsd: number,
    ruleTriggered: string,
    exitReason: string,
    forced: boolean
  ) => {
    if (!activePosition) return;
    // Adverse fill: exits never get the trigger print — emergency exits get the
    // panicked-book penalty, mirroring production's emergency slippage path.
    const emergency = EMERGENCY_RULES.has(ruleTriggered);
    const slipPct = emergency ? Math.max(8.0, slippagePct * 2.5) : slippagePct;
    const fillPriceUsd = triggerPriceUsd * (1 - slipPct / 100);
    const amountTokens = activePosition.amountTokens;
    const exitValueSol = (amountTokens * fillPriceUsd) / solPriceUsd;
    const sellFeeSol = networkSellFeeSol + exitValueSol * (dexFeePct / 100);
    const feesSol = activeBuyFeeSol + sellFeeSol;
    const grossPnlSol = exitValueSol - activeSizeSol;
    const netPnlSol = grossPnlSol - feesSol;
    const pnlPct = ((fillPriceUsd - activePosition.entryPriceUsd) / activePosition.entryPriceUsd) * 100;

    currentBalance += exitValueSol - sellFeeSol;
    trades.push({
      entryTimestamp: activeEntryTs,
      exitTimestamp: exitBarTs,
      entryPrice: activePosition.entryPriceUsd,
      exitPrice: fillPriceUsd,
      sizeSol: activeSizeSol,
      grossPnlSol: Number(grossPnlSol.toFixed(4)),
      feesSol: Number(feesSol.toFixed(4)),
      netPnlSol: Number(netPnlSol.toFixed(4)),
      pnlPct: Number(pnlPct.toFixed(2)),
      exitReason: forced ? `${exitReason} [FORCED]` : exitReason,
    });
    activePosition = null;
  };

  for (let i = 2; i < candles.length; i++) {
    const candle = candles[i];
    const prevCandle = candles[i - 1];
    const barTsSec = candle.timestamp;
    const nowMs = barTsSec * 1000;

    // 1. MANAGE OPEN POSITION — drive the production-mirror exit engine.
    //    Adverse intrabar order: evaluate the low (downside triggers) before
    //    the high (peak update), then the close (time-based rules).
    if (activePosition) {
      const evalPoints: Array<{ price: number; label: string }> = [
        { price: candle.low, label: 'LOW' },
        { price: candle.high, label: 'HIGH' },
        { price: candle.close, label: 'CLOSE' },
      ];
      for (const ep of evalPoints) {
        if (!activePosition) break;
        if (!(ep.price > 0)) continue;
        const signal = pm.evaluatePositionExit({
          position: activePosition,
          currentPriceUsd: ep.price,
          nowMs,
          solPriceUsd,
        });
        if (signal.shouldExit) {
          closeActive(barTsSec, ep.price, signal.ruleTriggered, `${signal.ruleTriggered} @${ep.label}: ${signal.reason}`, false);
          break;
        }
      }
    }

    // 2. ENTRY SIGNAL EVALUATION (synthetic — NOT the production scorer)
    if (!activePosition && currentBalance >= entrySizeSol + networkBuyFeeSol) {
      const prevBarChangePct = ((prevCandle.close - prevCandle.open) / prevCandle.open) * 100;
      const curBarChangePct = candle.open > 0 && prevCandle.close > 0
        ? ((candle.open - prevCandle.close) / prevCandle.close) * 100
        : 0;

      // Anti-Chase Guard (drift ceiling)
      if (curBarChangePct > CONFIG.MAX_PRICE_DRIFT_PCT) continue;

      let entryTriggered = false;
      if (entrySignal === 'continuation3') {
        // 3 consecutive rising closes, each with rising volume — the backtest
        // mirror of MOMENTUM_CONTINUATION's 3x higher-high confirmation.
        // NOTE: 5m bars make this SLOWER than production (tick-level pushes);
        // results understate confirmation speed, not edge direction.
        if (i >= 3 && candle.open > 0) {
          const b1 = candles[i - 3], b2 = candles[i - 2], b3 = candles[i - 1];
          const rising =
            b1.close > b1.open && b2.close > b2.open && b3.close > b3.open &&
            b2.close > b1.close && b3.close > b2.close;
          const volRising = b2.volume > b1.volume && b3.volume > b2.volume && candle.volume >= b3.volume * 0.8;
          entryTriggered = rising && volRising;
        }
      } else {
        // Synthetic signal: positive momentum breakout bar + rising volume
        entryTriggered = prevBarChangePct > 2.5 && candle.volume > prevCandle.volume && candle.open > 0;
      }

      if (entryTriggered) {
        const buyFeeSol = networkBuyFeeSol + entrySizeSol * (dexFeePct / 100);
        currentBalance -= (entrySizeSol + buyFeeSol);

        activePosition = {
          id: `bt-${i}`,
          tokenId: isPump ? `${tokenSymbol}-btpump` : `${tokenSymbol}-bt`,
          tokenSymbol,
          tokenName: tokenSymbol,
          status: 'OPEN',
          entryPriceUsd: candle.open,
          entrySol: entrySizeSol,
          amountTokens: (entrySizeSol * solPriceUsd) / candle.open,
          currentPriceUsd: candle.open,
          peakPriceUsd: candle.open,
          pnlUsd: 0,
          pnlPct: 0,
          isHalfClosed: false,
          targetTpPct: CONFIG.TAKE_PROFIT_PCT,
          targetSlPct: CONFIG.STOP_LOSS_PCT,
          strategyName: 'BACKTEST_MIRROR',
          openedAt: new Date(barTsSec * 1000).toISOString(),
        };
        activeSizeSol = entrySizeSol;
        activeBuyFeeSol = buyFeeSol;
        activeEntryTs = barTsSec;
      }
    }
  }

  // Force close any remaining open position at backtest end
  if (activePosition) {
    const lastCandle = candles[candles.length - 1];
    // Re-run the mirror at the final close so the recorded reason is truthful
    const signal = pm.evaluatePositionExit({
      position: activePosition,
      currentPriceUsd: lastCandle.close,
      nowMs: lastCandle.timestamp * 1000,
      solPriceUsd,
    });
    closeActive(
      lastCandle.timestamp,
      lastCandle.close,
      signal.ruleTriggered,
      signal.shouldExit ? signal.reason : 'END_OF_BACKTEST (no exit rule triggered)',
      true
    );
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
    metrics,
    assumptions,
  };
}

/**
 * Formats backtest results into an honest Telegram markdown report.
 * The header states plainly that this is a STRATEGY MIRROR approximation —
 * not production results — and the limitations are listed, not buried.
 */
export function formatBacktestTelegramReport(report: BacktestReport): string {
  const m = report.metrics;
  const isProfit = m.netPnlSol >= 0;
  const netReturnPct = ((report.finalBalanceSol - report.initialBalanceSol) / report.initialBalanceSol) * 100;

  let text = `🔬 *BACKTEST — STRATEGI MIRROR (aproksimasi, BUKAN hasil produksi)*\n\n` +
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
    `• Beban Fee Total: *-${m.totalFeesSol.toFixed(4)} SOL* (DEX venue-aware + network, kedua sisi)\n` +
    `• 🎯 *Net Realized PnL:* *${m.netPnlSol >= 0 ? '+' : ''}${m.netPnlSol.toFixed(4)} SOL* ${isProfit ? '💰' : '🔻'}\n` +
    `• Total Trade Selesai: *${m.totalTrades}* (Win Rate: *${m.winRatePct}%* - ${m.winTrades}W / ${m.lossTrades}L)\n\n`;

  if (report.trades.length > 0) {
    text += `📋 *Daftar Trade Simulasi (Terakhir):*\n`;
    const recentTrades = report.trades.slice(-4);
    for (const t of recentTrades) {
      const isWin = t.pnlPct >= 0;
      text += `• ${isWin ? '🟢' : '🔴'} *${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%* (${t.netPnlSol >= 0 ? '+' : ''}${t.netPnlSol.toFixed(4)} SOL) - \`${t.exitReason}\`\n`;
    }
    text += `\n`;
  }

  text += `⚠️ *Keterbatasan (baca sebelum mengutip angka):*\n`;
  for (const a of report.assumptions) {
    text += `• _${a}_\n`;
  }

  return text;
}
