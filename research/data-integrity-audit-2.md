# Data Integrity Audit #2 — 2026-09-29

**Auditor role:** Data Integrity Auditor (read-only). No code changed, no DB writes, no restarts.
**Scope:** `src/services/tradeManager.ts`, `src/execution/opportunityScorer.ts`, `src/services/marketStreamer.ts`,
plus the rest of `src/services/` and `src/execution/` not covered by sweep #1
(scanner/WS hot-path producers, storage, and feature plumbing).
**Principle:** a feature with no data must be `undefined` and fail closed — never filled with an invented number.
**Live entry paths confirmed:** `startMarketStreamer()` (called from `src/index.ts:58`) and the
algo-scanner cycle (`scanMarketOnce` → `opportunityScorer.scoreOpportunity` + `entryEngine.evaluateEntryTiming`).

## Verdict

Sweep #1 cleaned the producers it touched, but **the same fabrication patterns survive — and in some
cases got worse — in the two live entry paths**. Four CRITICAL findings: invented numbers that flow
directly into `entryEngine.evaluateEntryTiming` / `opportunityScorer.scoreOpportunity` and can flip a
NO into a YES. The single most dangerous one: when the token tape is immature, the scanner **invents
the pullback depth and the green rebound tick** — the exact two inputs that define PULLBACK_ABSORPTION.

**Count: 4 critical · 7 major · 6 minor.** Honest patterns that survived are listed at the end.

---

## CRITICAL — fabricated input reaches a live entry/exit/sizing decision

### C1. Invented pullback depth + invented rebound tick (scanner, tape immature)
**File:** `src/services/algoScanner.ts:443-460`

```ts
} else {
  // Conservative fallback while the tape matures: no invented drawdown,
  // no invented wicks. ...
  if (ret5m < 0) {
    drawdownFromPeakPct = Math.abs(ret5m);
    return1m = (buySellRatio >= 1.35 && ret5m >= -6.5) ? 0.5 : ret5m * 0.2;
  } else if (ret5m > 8.0) {
    drawdownFromPeakPct = 0.5;
    return1m = 1.0;
  } else {
    drawdownFromPeakPct = 0;
    return1m = ret5m * 0.15;
  }
```

The comment claims "no invented drawdown" — the code invents both. Trace through
`entryEngine.evaluateEntryTiming` for a token with a real −5% 5m candle, no tape, buy-dominant flow:
- `drawdownFromPeakPct = 5` → lands inside the 2–8% pullback band (passes Invalidation 3 knife guard, `> 8.0`).
- `return1m = 0.5` → Invalidation 5 only blocks when `return1m <= -0.5`; `0.5` passes as a "green rebound tick".

So the two defining inputs of PULLBACK_ABSORPTION — pullback depth and rebound confirmation —
are manufactured from one 5m return. This vector then goes to `scoreOpportunity` (line 506) and
`evaluateEntryTiming` (line 507). The `ret5m * 0.2` / `ret5m * 0.15` variants are the same
synthesize-short-timeframe-from-longer-timeframe class as the banned `return15m = return5m × 1.2`.
**Fix:** when the tape is immature, do not score for pullback entry at all (fail closed), or make
`return1m`/`drawdownFromPeakPct` optional in `FeatureVector` and have the entry engine treat
unknown as "no entry" for the pullback model. Delete the false comment.

### C2. Fully synthetic market snapshot for unindexed pump.fun tokens
**File:** `src/services/algoScanner.ts:249-266`

```ts
market = {
  ...
  priceChange24h: 0,
  priceChange5m: 3.5,                                        // invented
  volume24h: curve.liquiditySol * solPrice,                  // liquidity mislabeled as volume
  volume1h: (curve.liquiditySol * solPrice) * 0.3,           // invented
  volume5m: (curve.liquiditySol * solPrice) * 0.1,           // invented
  txns5mBuys: 20,                                           // invented
  txns5mSells: 6,                                           // invented
  pairCreatedAt: Date.now() - (600 * 1000)                   // invented age
};
```

This fallback fires when DexScreener hasn't indexed a `*pump` token. The invented values are
**tuned to pass the entry gates**: `priceChange5m: 3.5` sits in the scorer's 2.5–55 momentum sweet
spot; 20/6 buys/sells = 3.33x ratio, comfortably above the 1.35 buy-dominance gate; `volume24h =
liquidity` passes the $30k volume gate at line 157 for any curve with ≥ $30k liquidity.
Downstream this fabricates: `rvol5m = (0.1×liq × 12)/(0.3×liq) = 4.0` → MOMENTUM signal fires
(≥1.6, ret5m ≥ 2.5); `buySellRatio 3.33 ≥ 1.6` → FLOW_IMBALANCE signal fires; `buyPressureScore = 90`
(ratio ≥ 1.8, 26 trades). A token with **zero measured momentum, volume, or trades** can reach
ENTRY on invented inputs.
**Fix:** if there is no market data, do not score. Quarantine these candidates to watchlist-only
(price tracking) until DexScreener indexes them. Never invent `txns` counts.

### C3. Three different invented buy/sell ratios for the "zero sells" case
**Files:** `src/services/algoScanner.ts:348`, `src/services/marketStreamer.ts:486`,
`src/services/algoScanner.ts:689`

```ts
// algoScanner.ts:348 (live scoring vector)
const buySellRatio = sells5m > 0 ? (buys5m / sells5m) : (buys5m > 0 ? 3.0 : 1.0);
// marketStreamer.ts:486 (live WS hot path)
const realBuySellRatio = sells5m > 0 ? (buys5m / sells5m) : (buys5m >= 8 ? 2.5 : 1.0);
// algoScanner.ts:689 (Telegram dataReason, displayed as measured fact)
buySellRatio: best.sells5m > 0 ? (best.buys5m / best.sells5m) : 2.0,
```

Three modules invent three different constants (3.0 / 2.5 / 2.0) for the same unmeasured case.
The 3.0 and 2.5 branches **pass** the 1.35 buy-dominance gate in `entryEngine` Invalidation 2,
can fire the FLOW_IMBALANCE signal (≥1.6), and push `buyPressureScore` to 90 (≥1.8) — all on
"we saw no sells", which for a fresh/unindexed token usually means "we saw no data".
`flowImbalance` (computed beside them) handles the zero case honestly: `(buys-0)/(buys+0) = 1.0`.
**Fix:** single rule — if `sells5m == 0`, ratio is `undefined`; gates that need it fail closed
(`flowImbalance` already covers the dominance question without invention). Delete the 2.0 in
`dataReason`; Telegram must not print "2.0x Dominasi Buyer" for unmeasured flow.

### C4. Synthesized volume baselines feeding RVOL / volumeAcceleration
**Files:** `src/services/algoScanner.ts:350-354`, `src/services/marketStreamer.ts:472,503`

```ts
// algoScanner.ts:350-351
const volume5mUsd = tape.intervalVolumeUsd ?? market.volume5m ?? ((market.volume24h || 0) / 288);
const volume1hUsd = market.volume1h || ((market.volume24h || 0) / 24);
// algoScanner.ts:354
const rvol5m = volume1hUsd > 0 ? Math.min(10, (volume5mUsd * 12) / volume1hUsd) : 1.0;
// marketStreamer.ts:472
const vol1hUsd = realMarketData.volume1h || ((realMarketData.volume24h || 0) / 24);
```

1h volume as `24h/24` (and 5m as `24h/288`) is the linear-extrapolation fabrication class.
`rvol5m` becomes `volumeAcceleration` in the `FeatureVector` → scorer Volume component and the
MOMENTUM signal threshold (`rvol5m >= 1.6`). When both sides are synthesized they cancel to 1.0
by luck; when only one side is real, RVOL is garbage that still scores points.
**Fix:** if the 1h baseline is missing, `volumeAcceleration` is `undefined` and the scorer's
Volume component scores 0 (fail closed, like buy-pressure already does). Never divide by a
synthesized baseline.

---

## MAJOR — wrong or misleading, in/near live paths

### M1. `realizedVol` and `atrPct` invented from a single 5m return; regime misclassified
**Files:** `src/services/marketStreamer.ts:503`, `src/services/algoScanner.ts:358-359`

```ts
// marketStreamer.ts:503 (WS hot path — module HAS tick priceHistory and doesn't use it)
const realizedVol = Math.max(4.0, Math.abs(effectiveRet5m) * 1.3);
// algoScanner.ts:358-359
const realizedVol = tape.realizedVolPct ?? Math.max(2.0, Math.abs(ret5m) * 1.25);
const atrPct = Math.max(3.0, realizedVol * 1.2);
```

A field named `realizedVol` that is `|5m return| × 1.3` is mislabeled measurement. It feeds:
- `regime: realizedVol >= 10.0 ? 'HIGH_VOLATILITY' : ...` → wrong regime shifts the
  regime-aware entry hurdle (+5 HIGH_VOL / +8 PANIC) in `entryEngine`;
- scorer's Volatility component (`realizedVol >= 12.0` → +8 points) — invented vol directly
  adds score points;
- the `× 1.2` ATR chain repeats the banned multiplier pattern on top of invented vol.
**Fix:** compute realized vol from the actual tick `priceHistory` (marketStreamer already keeps it),
or leave `realizedVol` undefined and derive regime/hurdle without it.

### M2. Hardcoded $180 SOL in the price-impact safety gate while a live price is in scope
**File:** `src/services/marketStreamer.ts:496` (gate 4, live WS path)

```ts
const buyAmountUsd = (CONFIG.DEFAULT_BUY_AMOUNT_SOL || 0.05) * 180;
const estImpactPct = liquidityUsd > 0 ? (buyAmountUsd / (liquidityUsd * 0.5)) * 100 : 99;
if (estImpactPct > 1.5) { return; }
```

`cachedSolPriceUsd` (updated from a live fetch at line 328, used honestly at line 512) exists in
the same module, but the impact gate uses a stale `$180` literal. If SOL is $220, impact is
underestimated ~18% and the 1.5% gate is too lenient; `estimatedPriceImpactPct` also feeds
`entryEngine` Invalidation 6 (> 3.5%) and the scorer's SlippageImpact penalty.
**Fix:** use `cachedSolPriceUsd`.

### M3. Three different hardcoded SOL/USD prices across modules
`$150` in `src/execution/executionEngine.ts:111` and `src/execution/positionManager.ts:59`;
`$180` in `src/services/marketStreamer.ts:68,496` and `src/services/algoScanner.ts:365`
(fallback). `positionManager` is the backtest mirror — its `pnlUsd = entrySol × 150 × pnl%`
bakes a wrong SOL price into every backtested USD PnL. **Fix:** single SOL-price source
(`getSolPriceUsd()` / cached), no literals.

### M4. Dead `executionEngine.ts` is a fabrication landmine
**File:** `src/execution/executionEngine.ts:108-123` — no callers (only re-exported from
`src/execution/index.ts`), but:

```ts
const simulatedSlippagePct = 0.25;   // comment claims "randomized (0.1% - 0.4%)" — it is fixed
const executedTokens = (intent.requestedSol * 150) / executedPriceUsd; // assume ~$150 SOL
...
slot: 290123456,                     // fake slot stored as if real
txSignature: `SIM_${Date.now()}_...`,
```

Plus `executeLiveOnChain` **silently returns a paper fill** ("Fallback to simulated fill if live
execution environment lacks signing keys") — in LIVE mode it would record CONFIRMED fills for
trades that never touched the chain. **Fix:** delete the module (nothing calls it), or quarantine
with a hard throw in the live path. At minimum the fake `slot` must never be written to the DB.

### M5. Whale/copy-trading legacy: default-ON kill switch with no callers
- `src/config.ts:50`: `COPY_SELL_ENABLED: process.env.COPY_SELL_ENABLED !== 'false'` —
  **defaults to true** ("Auto-dump when whale dumps").
- `src/services/tradeManager.ts:901-927`: `executeWhaleSellFollow` would 100%-liquidate a
  position on a whale-dump signal. **Zero callers** today, but the flag is ON.
- `src/services/tradeManager.ts:545,552-553`: `whale ? 'WHALE_COPY' : ...` and
  `🐋 SMART MONEY INFLOW (Paus Akumulasi)` labels; `src/services/tradeManager.ts:779-792`:
  `recordWhaleTrade` + `🎖️ PROMOSI ELITE SMART MONEY!` promo messages.

The user explicitly rejected whale-follow framing for this project; `whale` is `undefined` in
both live callers (algoScanner:682, telegram:1235 pass `undefined`), so this is dormant — but
a default-ON copy-sell plus user-facing "smart money" copy is a loaded gun and a misleading
product claim. **Fix:** default `COPY_SELL_ENABLED` to false (or delete `executeWhaleSellFollow`
entirely), delete the WHALE_COPY/SMART MONEY labels and promo messages, or keep them behind an
explicit opt-in with honest "experimental, no wallet tracking" labeling.

### M6. Banned `×1.2` pattern survives at the call site; false "Adaptive" claim to user
**File:** `src/services/tradeManager.ts:526,635`

```ts
const dynamicTargets = adaptiveLearningEngine.getDynamicTpSl(absVol, absVol * 1.2);
```

`getDynamicTpSl(_realizedVol, _atrPct)` ignores both args (underscore-prefixed) and returns
static 45% TP / 9.5% SL — the engine itself is honest (good docstring). But the call site still
carries the exact banned `×1.2` synthesis pattern in the live entry path, one refactor away from
becoming live again. And the user-facing message claims otherwise:

```ts
`🎯 *Target TP:* +${targetTpPct}% | 🛑 *Cut Loss:* -${targetSlPct}% (Adaptive Volatility)`
```

Targets are static; "(Adaptive Volatility)" is false. **Fix:** drop the second arg (or pass a
real measured ATR), fix the Telegram label to "(statis)".

### M7. `|| 0` at the data source erases unknown-vs-measured
**File:** `src/services/dexscreener.ts:96-103`

```ts
priceChange1h: bestPair.priceChange?.h1 || 0,
volume1h: bestPair.volume?.h1 || 0,
txns5mBuys: bestPair.txns?.m5?.buys || 0,
txns5mSells: bestPair.txns?.m5?.sells || 0,
```

"No data" becomes indistinguishable from "measured zero" at the source — and `txns5mSells: 0`
is exactly what arms the invented-ratio branches in C3. **Fix:** preserve `null`/undefined for
"unknown" on fields where the distinction matters (txns, priceChange1h); let downstream gates
fail closed on unknown.

---

## MINOR

- **m1.** `avgTradeSizeUsd` fallback `$80`, `avgTradeSizeSol` fallback `0.5`
  (`algoScanner.ts:366-367`, `marketStreamer.ts:511`). Currently benign (the fields that consume
  them require trade counts that imply the fallback is unreachable), but magic all the same —
  replace with `undefined`.
- **m2.** `ret1h = market.priceChange1h ?? 0` (`algoScanner.ts:465`) contradicts the honest comment
  at line 438 ("unknown means unknown"). Benign in current gates; make the comment and code agree.
- **m3.** `getEmpiricalKellyStats` (`src/db/index.ts:846`): `avgLoss = ... : 10` when there are no
  losses — invented denominator in the all-wins edge case. Benign at n≤5; replace with a documented
  prior instead of a bare literal.
- **m4.** `dexSimulator.ts`: `poolLiquidityUsd = 20000` default param and
  `poolTokenReserve = ... : 1_000_000` fallback. Callers currently pass real liquidity; keep the
  default but log loudly when it fires, or make it required.
- **m5.** Watchlist eviction `(item.score || 50)` (`marketStreamer.ts:122`) — unscored items assumed
  mid-quality; affects retention, not entries. Document or use recency-only.
- **m6.** Sizing docstring says prior `(p=37.5%, b=10)` but code uses `(p=0.35, b=3.0)`
  (`tradeManager.ts` ~line 99 vs 116). Doc/code drift — pick one.

## Honest patterns worth keeping (found intact)

- `return15m` is tape-measured or `undefined` — never synthesized (both entry paths).
- `cabalClusterRiskScore: undefined` on the WS hot path; scanner uses the real safety-gate
  outcome (`safety.isSafe ? 10 : 60`) instead of the old hardcoded `10`.
- `netBuyFlowSolEst` / `buyPressureScore` left `undefined` when the trade sample is thin
  (both paths); scorer treats unknown as 0 points (fail closed).
- `getEmpiricalKellyStats` reads real closed positions from SQLite; Bayesian prior is documented.
- `dexSimulator` tries a live Jupiter quote first and labels the fallback
  (`executionMethod: 'AMM_CONSTANT_PRODUCT'`).
- `entryEngine` wick guard skips when `upperWickRatio` is unknown instead of inventing one.
- `tradeManager.ts:562`: `ratioVal = dataReason?.buySellRatio ?? (computed or undefined)` —
  no invention at that site (the invented 2.0 arrives via `dataReason` from the scanner, C3).

## Recommended fix order

1. **C1** — kill the tape-fallback invention (the pullback model's own inputs are invented).
2. **C2** — delete/quarantine the synthetic bonding-curve snapshot.
3. **C3 + M7** — one honest rule for zero-sell/unknown flow; preserve unknown at the source.
4. **C4** — drop 24h/24 and 24h/288 volume syntheses; RVOL undefined when baseline missing.
5. **M1** — real realized-vol from tick history or undefined; regime from real vol.
6. **M2 + M3** — single SOL-price source; delete 150/180 literals.
7. **M5** — default `COPY_SELL_ENABLED=false` (or delete); remove smart-money copy.
8. **M4** — delete or quarantine `executionEngine.ts`.
9. **M6** — drop the `×1.2` arg; fix the "(Adaptive Volatility)" label.
10. **Minors** — replace magic fallbacks with `undefined`, fix doc drift.
