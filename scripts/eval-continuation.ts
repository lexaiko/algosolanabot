/**
 * Eval: MOMENTUM_CONTINUATION vs baseline breakout entry.
 * Both variants exit via the PRODUCTION ratchet (PositionManager).
 * Usage: npx tsx scripts/eval-continuation.ts
 */
import { runBacktest, generateSyntheticRegime, fetchHistoricalCandles, Candle } from '../src/services/backtester';

const SEEDS = [42, 7, 123, 999];
const REGIMES = ['BULL', 'CHOP', 'BLOODBATH', 'PUMP_DUMP'] as const;

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function summarize(label: string, m: any) {
  return {
    label,
    trades: m.totalTrades,
    wr: m.winRatePct?.toFixed(1),
    pf: m.profitFactor?.toFixed(2),
    exp: m.tradeExpectancySol?.toFixed(4),
    dd: m.maxDrawdownPct?.toFixed(2),
  };
}

async function main() {
  console.log('=== CONTINUATION EVAL: baseline(1-bar, full size) vs continuation3(3-bar, half size) ===\n');
  const rows: any[] = [];

  for (const regime of REGIMES) {
    for (const seed of SEEDS) {
      const rand = seededRandom(seed);
      const origRandom = Math.random;
      (Math as any).random = rand;
      const { candles, tokenSymbol } = generateSyntheticRegime(regime, 120);
      (Math as any).random = origRandom;

      const base = runBacktest(candles, `${tokenSymbol}-${regime}-s${seed}`, 10, 0.05, { entrySignal: 'baseline' });
      const cont = runBacktest(candles, `${tokenSymbol}-${regime}-s${seed}`, 10, 0.05, { entrySignal: 'continuation3' });
      rows.push({ regime, seed, base: summarize('base', base.metrics), cont: summarize('cont', cont.metrics) });
    }
  }

  console.log('regime     seed | base trades/WR%/PF/exp/DD%  || cont trades/WR%/PF/exp/DD%');
  for (const r of rows) {
    const b = r.base, c = r.cont;
    console.log(
      `${r.regime.padEnd(10)} ${String(r.seed).padEnd(4)} | ` +
      `${String(b.trades).padStart(3)} ${String(b.wr).padStart(5)} ${String(b.pf).padStart(6)} ${String(b.exp).padStart(8)} ${String(b.dd).padStart(6)} || ` +
      `${String(c.trades).padStart(3)} ${String(c.wr).padStart(5)} ${String(c.pf).padStart(6)} ${String(c.exp).padStart(8)} ${String(c.dd).padStart(6)}`
    );
  }

  // Aggregate
  const agg = (key: 'base' | 'cont') => {
    let t = 0, w = 0, net = 0, dd = 0;
    for (const r of rows) {
      // re-run-free approx: use metrics sums (trades may double count across seeds — fine for comparison)
      t += (r[key].trades as number);
    }
    return { trades: t };
  };
  console.log('\nAggregate trades:', JSON.stringify(agg('base')), JSON.stringify(agg('cont')));

  // --- Real candles: today's skipped runners ---
  console.log('\n=== REAL CANDLES (minute, GeckoTerminal) ===');
  const mints: Array<[string, string]> = [
    ['9k7NgXqiJ7tvLtiB6HXdJHnKZZynFz46AB6Eg4Uwpump', 'INUINK'],
    ['9pMXEbTjQ5HHiYifGbNBwkMkrQxGyhuSmB8ndKNXpump', 'SICAT'],
    ['5GefefPX1mDs6ZJB1apYmz6fCTCiNJpHturZ9bvFpump', 'Pumpoween'],
  ];
  for (const [mint, sym] of mints) {
    try {
      const { candles } = await fetchHistoricalCandles(mint, 'minute', 300);
      if (candles.length < 30) { console.log(`${sym}: only ${candles.length} candles — skipped`); continue; }
      const base = runBacktest(candles, sym, 10, 0.05, { entrySignal: 'baseline' });
      const cont = runBacktest(candles, sym, 10, 0.05, { entrySignal: 'continuation3' });
      const f = (m: any) => `${m.totalTrades}t WR${m.winRatePct?.toFixed(0)}% PF${m.profitFactor?.toFixed(2)} net${m.netPnlSol?.toFixed(4)}`;
      console.log(`${sym} (${candles.length} bars): base[${f(base.metrics)}] cont[${f(cont.metrics)}]`);
    } catch (e: any) {
      console.log(`${sym}: fetch failed — ${e.message}`);
    }
  }
  console.log('\nDone. NOTE: synthetic entries are NOT the production scorer; this compares ENTRY TIMING only.');
}

main().catch(e => { console.error(e); process.exit(1); });
