# Audit Entry Pipeline — Hulu ke Hilir

**Tanggal:** 29 Sep 2026 · **Auditor:** subagent read-only · **Scope:** seluruh jalur entry
(`algoScanner.ts` → `marketStreamer.ts` → `tokenTape.ts` → `discoveryFunnel.ts` →
`opportunityScorer.ts` → `entryEngine.ts` → `tradeManager.ts` [`getDynamicAlgoBuyAmount`, `executeBuyToken`] →
`dexscreener.ts` → `adaptiveLearningEngine.ts` → `db/index.ts` → `dexSimulator.ts`)

**Metode:** baca source penuh tiap file, verifikasi manual tiap klaim di kode (bukan dari komentar).
Komentar kode terbukti beberapa kali berbohong (kasus C1 kemarin terulang dalam bentuk baru — lihat M5, M6, M8).

**Verdict satu kalimat:** tidak ada phantom-entry atau double-entry (WS tidak pernah buy, lock `activeOrderTokens` sound),
tapi ada **2 bug window yang sistematis melemahkan gate R1/R4 tepat di satu-satunya jalur yang bisa buy**,
**3 fabrikasi angka yang lolos dari audit #2** (funnel stage mati / tersamar), dan **dataset decision journal yang terkontaminasi label EXECUTED palsu**.

---

## Temuan MAJOR (urut dampak)

### M1 — `volumeAcceleration` 2x inflated: interval 10-menit diberi label volume 5-menit
**`src/services/algoScanner.ts:375-379`** ← `src/market/tokenTape.ts` (`intervalVolumeUsd`)

```ts
const volume5mUsd: number | undefined = tape.intervalVolumeUsd ?? market.volume5m;   // :375
const volumeAcceleration =
  (volume5mUsd !== undefined && volume1hUsd !== undefined && volume1hUsd > 0)
    ? Math.min(10, (volume5mUsd * 12) / volume1hUsd)                                   // :379
    : undefined;
```

`tape.intervalVolumeUsd` = delta `volume24h` antara dua observasi **pembawa volume** terakhir.
Satu-satunya pencatat observasi bervolume adalah `scanMarketOnce` (`algoScanner.ts:285`), yang jalan tiap
`SCAN_INTERVAL_MS = 10 mnt`. Tick WS mencatat `volume24hUsd = 0` dan **dilewati** oleh pencarian volume di tape.
Jadi "interval" ini ≈ **10 menit, bukan 5 menit** — tapi dikali `12` (annualisasi 5mnt→jam).

**Dampak ke P&L paper (sistematis, bukan noise):**
- `volumeAcceleration` 2x lebih besar dari definisinya (2.6x jika scan terlambat).
- Scorer `Volume` (`opportunityScorer.ts`, `min(volAccel,3)/3 × bobot`) jenuh ke skor maksimum 2x lebih mudah.
- **R1 absorption gate** (`entryEngine.ts`, syarat `volumeAcceleration >= 1.5` sebagai "partisipasi riil")
  efektif menjadi **0.75x** — gate yang dirancang untuk memblokir rebound sepi justru diloloskan oleh angka yang digelembungkan.
- Ripple: `avgTradeSizeUsd = volume5mUsd / tradeCount5m` (`:392`) ikut 2x → `netBuyFlowSolEst` 2x →
  signal `BUY_PRESSURE` (threshold ≥ 2.0 SOL) 2x lebih mudah fire.

**Fix konkret:** normalisasi ke ekuivalen 5-menit memakai elapsed aktual:
```ts
// TapeFeatures tambah: minutesBetweenVolumePoints: number | null
const vol5m = (tape.intervalVolumeUsd !== null && tape.minutesBetweenVolumePoints)
  ? tape.intervalVolumeUsd * (5 / tape.minutesBetweenVolumePoints)
  : market.volume5m;
```

### M2 — `return1m` sebenarnya return ~10-menit: gate rebound R4 ~10x lebih lemah dari desain
**`src/services/algoScanner.ts:484`** ← `src/market/tokenTape.ts:101-108`

```ts
return1m = tape.returnSinceLastPct ?? 0;   // "since last" = observasi sebelumnya ≈ 10 mnt lalu
```

`returnSinceLastPct` = return vs titik tape sebelumnya. Di jalur scanner (satu-satunya jalur yang bisa buy —
WS tidak pernah buy, lihat bagian "Yang sudah benar"), titik sebelumnya ≈ 10 menit lalu.
R4 (`entryEngine.ts:129`: `return1m <= 0.3` → tolak) dirancang sebagai **"green rebound tick"** — tapi yang
diukur adalah **drift 10-menit > +0.3%**, kira-kira **10x lebih lemah** dari laju +0.3%/menit yang dimaksud.
Hampir semua window 10-menit yang tidak dump lolos. Lebih parah: semantiknya inkonsisten antar feed —
untuk token watchlist (tape rapat, tick per detik) `returnSinceLastPct` bisa berarti 5 detik
(+0.3% dalam 5 detik = violent, bukan "rebound sehat").

**Dampak:** R4 adalah jantung konfirmasi rebound PULLBACK_ABSORPTION; dalam implementasinya ia hampir tidak memfilter
apa-apa di jalur entry. Paper trade yang tercatat "rebound terkonfirmasi" sebagian besar tidak memenuhi definisi desain.

**Fix konkret:** hitung laju per-menit —
```ts
// TapeFeatures tambah: minutesSincePrevPoint: number | null
const returnPerMin = (tape.returnSinceLastPct !== null && tape.minutesSincePrevPoint)
  ? tape.returnSinceLastPct / tape.minutesSincePrevPoint : null;
// R4: returnPerMin !== null && returnPerMin > 0.3, unknown → fail closed
```

### M3 — Decision-fill decoupling: `executeBuyToken` tidak pernah re-validasi verdict di data fresh
**`src/services/tradeManager.ts:163`** (`executeBuyToken` tidak import `opportunityScorer`/`entryEngine` sama sekali)

Alur: `scanMarketOnce` (fetch data → `checkTokenSafety` → 2x `getOnChainBondingCurve` → scoring → verdict,
~10–60 detik untuk 6 token) → `runAlgoScanCycle` → `executeBuyToken` (fetch ulang market data **fresh**,
tapi **tidak** menjalankan ulang scorer/entryEngine). Yang dicek ulang hanya guard kasar:
likuiditas, volume, mcap, anti-FOMO 5m, safety. Guard `upperWickRatio` (`tradeManager.ts` ~:470)
memakai `dataReason` — **nilai saat scan**, bukan saat fill.

**Dampak:** token yang lolos absorpsi 30 detik lalu bisa dibeli setelah rebound-nya gagal — harga fill-nya fresh
(simulasi pakai `marketData` baru), tapi **keputusan entry-nya basi**. Win rate paper jadi optimistis vs live.

**Fix konkret:** di `executeBuyToken`, setelah fetch `marketData` fresh, bangun ulang `FeatureVector` ringkas dan
jalankan `entryEngine.evaluateEntryTiming`; tolak jika `!shouldEnter`. (Butuh tape read — murah, in-memory.)

### M4 — Decision journal: label `EXECUTED` ditulis saat verdict, bukan saat fill (dataset terkontaminasi)
**`src/services/algoScanner.ts:652-663`**

```ts
await journal.logCandidateDecision({
  ...
  decision: isPassed ? 'EXECUTED' : 'SKIPPED',   // ditulis SEBELUM runAlgoScanCycle memutuskan buy
```

Fakta: (1) ditulis untuk **semua** kandidat passed per siklus, padahal `runAlgoScanCycle` hanya membeli **1**
(`qualifying[0]`); (2) ditulis **sebelum** `executeBuyToken` — veto apapun setelahnya (saldo, max posisi,
safety, likuiditas, heat cap, daily stop, sim gagal) tidak mengubah label; (3) tidak ada satupun
`logCandidateDecision`/`DecisionJournal` di `tradeManager.ts` (grep: nol) — tidak ada rekonsiliasi dengan fill nyata.

**Dampak:** tabel yang disebut "dataset untuk fit bobot scorer secara empiris" (komentar di kode) penuh
false-EXECUTED. Statistik "458 keputusan = 5 EXECUTED" kemarin juga berasal dari semantik ini.
Fitting bobot di atas label palsu = mengoptimasi ke keputusan yang tidak pernah dieksekusi.

**Fix konkret:** saat scan log `decision: 'EVALUATED'` (+ `verdict: 'PASS'/'SKIP'`); tulis/mark `EXECUTED`
hanya dari `executeBuyToken` saat `success: true` (bawa `position.id`).

### M5 — Funnel STAGE 4 (DEV_CONCENTRATION) mati secara matematis — input karangan takkan pernah melewati threshold
**`src/services/algoScanner.ts:323`** → **`src/market/discoveryFunnel.ts` STAGE 4**

```ts
const devHoldingPct = Math.min(top10 * 0.08, 6.0);          // max 6.0 — KARANGAN (8% dari top10)
...
if (devHoldingPct !== undefined && devHoldingPct > maxDevHolding)  // maxDevHolding default 8.0
```

Input maksimum 6.0, threshold 8.0 → **gate tidak akan pernah fire**. Komentar di scanner mengklaim
"Real holder metrics from anti-rug audit" — padahal `devHoldingPct` adalah formula, bukan pengukuran.
Ini pola yang sama persis dengan C3 kemarin (angka karangan berlabel "real").

**Dampak:** klaim proteksi konsentrasi dev adalah teater; token dengan dev holding 30%+ lolos dengan "skor" 6.0.

**Fix konkret:** ukur real via Helius `getTokenLargestAccounts` (atau DAS `getAsset`), atau **hapus STAGE 4**
dan nyatakan jujur bahwa konsentrasi dev tidak dinilai.

### M6 — Funnel STAGE 5 (HOLDER_DISPERSION) adalah volume gate yang tersamar
**`src/services/algoScanner.ts:324`** → **`src/market/discoveryFunnel.ts` STAGE 5** (`minHolders` default 45)

```ts
const uniqueHoldersCount = Math.max(30, Math.floor((market.volume24h || 50000) / 1500));  // KARANGAN
```

`max(30, vol/1500) >= 45` ⟺ `volume24h >= $67.500`. Stage "dispersi holder" ini **tidak mengukur holder sama sekali** —
ia secara diam-diam menaikkan bar volume efektif dari $30k (upstream gate) menjadi **$67.5k**,
dengan label yang salah. Siapapun yang menurunkan `MIN_VOLUME_24H_USD` akan bingung kenapa token tetap tertolak.

**Dampak:** bukan loss langsung (arahnya konservatif), tapi (a) dishonest labeling, (b) token $30k–$67.5k
yang lolos upstream mati di sini tanpa alasan yang tercatat jujur, (c) menutupi tuning volume yang sebenarnya.

**Fix konkret:** fetch holder count real, atau hapus STAGE 5 dan naikkan `MIN_VOLUME_24H_USD` ke 67500 secara eksplisit
jika itu memang bar yang diinginkan.

### M7 — Buy-side tanpa stale-price guard (sell side sudah punya)
**`src/services/dexscreener.ts:53,168`** + **`src/services/tradeManager.ts:163`**

Saat 429 backoff, `getTokenMarketData`/`getMultiTokenMarketData` menyajikan **cache tanpa cek umur**
(`if (cached) return cached.data`). `TokenMarketData` tidak membawa `fetchedAt`, jadi jalur buy
**tidak bisa tahu** datanya basi. `executeSellToken` sudah punya "Anti stale/fake price" guard —
`executeBuyToken` hanya cek `if (!marketData)` (null), bukan staleness.

**Dampak:** saat 429 storm di pasar volatil, paper fill dieksekusi di harga basi menit-menit —
cenderung optimistis (membeli di harga pre-dump yang sudah tidak ada).

**Fix konkret:** tambahkan `fetchedAt: number` di `TokenMarketData`; di `executeBuyToken` tolak jika
`Date.now() - fetchedAt > 60_000` (atau beri penalti slippage eksplisit dan tandai).

### M8 — Ingestion dari DexScreener **paid boosts** dengan klaim "NOT paid ads"
**`src/services/algoScanner.ts:76`**

```ts
// 1b. DexScreener Top Boosted Solana Velocity Tokens (Hot runners with verified organic volume & community velocity)
const boostRes = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', ...
```

Docstring fungsi mengklaim *"Real AMM activity, NOT paid ads"*. Endpoint `token-boosts/top/v1`
**adalah** iklan berbayar DexScreener — token membayar untuk muncul di situ. Ini adverse selection
sistematis di hulu: kumpulan kandidat condong ke skema promosi/dump. Gate downstream memang masih
menjaga, tapi distribusi inputnya beracun.

**Fix konkret:** hapus sumber 1b, atau tag mint boosted dan wajibkan skor +10 / gate lebih ketat.

### M9 — Loss-streak decay (anti-martingale) pakai `pnl_pct` GROSS, tidak konsisten dengan Kelly & daily stop yang NET
**`src/db/index.ts:602-617`** ← `:771` (`pnl_pct` = pure price return, gross of fees)

`getConsecutiveAlgoLosses` membaca `positions.pnl_pct` (gross). Trade +0.5% gross / **-2.4% net**
(setelah round-trip fee ~2.9%) dihitung **WIN** → me-reset decay 0.75^n. Sementara Kelly (`getEmpiricalKellyStats`,
net — F-04) dan daily stop (`getDailyRealizedPnl`, net — F-07) menghitungnya LOSS. Tiga komponen risk
memakai **tiga definisi menang/kalah yang berbeda**.

**Dampak:** tepat saat fee menggerogoti (trade kecil di sekitar BEP), sizing tidak mengecil sebagaimana dirancang.

**Fix konkret:** hitung streak dari `trade_history.net_pnl_sol > 0` (kolom yang sama dengan Kelly).

### M10 — `effectiveLiquidity` karangan untuk pump.fun saat curve fetch gagal → gate likuiditas lolos di atas depth estimasi
**`src/services/tradeManager.ts:411-413`**

```ts
const effectiveLiquidity = marketData.liquidityUsd > 0
  ? marketData.liquidityUsd
  : (isPumpFun && marketData.marketCap >= 5000 ? Math.max(5000, marketData.marketCap * 0.35) : marketData.liquidityUsd);
```

Jika fetch kurva on-chain gagal **dan** DexScreener lapor likuiditas 0, depth **ditebak** 35% dari mcap
(min $5k). Nilai tebakan ini dipakai di **gate** `MIN_LIQUIDITY_USD` **dan** simulasi price impact
(`simulateRealisticBuy`) — paper fill terlihat murah di pool yang depth-nya tidak terverifikasi.

**Dampak:** arah fail-open di safety gate; slippage paper understated untuk kasus ini.

**Fix konkret:** fail closed — jika `isPumpFun` dan depth tak terverifikasi (curve gagal + liq 0), tolak buy.
Read kurva on-chain <50ms; tidak ada alasan memakai tebakan.

### M11 — Consensus bonus (+10) untuk 3 signal dari **satu** window 5-menit yang sama
**`src/execution/opportunityScorer.ts:72`**

```ts
if (signals.length >= 2) positivePoints['StrategyConsensus'] = weights.consensusBonus; // 10
```

Di jalur scanner, `MOMENTUM` (volAccel+ret5m), `FLOW_IMBALANCE` (buy/sell count), `BUY_PRESSURE`
(netBuyFlow dari count yang sama) semuanya diturunkan dari **txn/volume 5m yang identik**.
Ini bukan "konsensus multi-strategi independen" — satu observasi memakai tiga topi, diganjar +10.

**Dampak:** inflasi skor sistematis untuk token dengan satu window 5m yang panas; menggerus makna hurdle 75.

**Fix konkret:** bonus hanya jika signal dari sumber independen (mis. tape vs DexScreener),
atau turunkan ke +4 dengan komentar jujur bahwa ini satu sumber.

### M12 — Celah Invalidation 5: `drawdownFromPeakPct` ∈ [1.5%, 2%) lolos tanpa rebound tick
**`src/execution/entryEngine.ts:129`** (dikenal — komentar R8 di scorer menyebutnya "tracked")

```ts
if (features.drawdownFromPeakPct >= 2.0 && features.return1m <= 0.3) // AWAITING_GREEN_REBOUND_TICK
```

Kombinasi dengan Invalidation 4 (`return5m > 8 && dd < 1.5`): token dengan dd 1.5–2.0%, ret5m ≤ 8%,
dan **tick flat** lolos tanpa pullback nyata dan tanpa rebound. Scorer bahkan memberi +5 PullbackShape
(`return1m > 0`) untuk tick nyaris-flat.

**Fix konkret:** satu baris — `>= 2.0` → `>= 1.5`.

---

## Temuan MINOR

| # | Lokasi | Isu | Arah |
|---|--------|-----|------|
| m1 | `algoScanner.ts:383`, `marketStreamer.ts:430` | `realizedVol = \|ret5m\|×1.25/1.3` sintetis masih aktif saat tape < 4 poin (butuh 4 untuk `realizedVolPct` real; `tapeReady` cuma butuh 2). Menggerakkan klasifikasi regime → regime hurdle. (Deferred M1 — tetap tercatat) | netral/campur |
| m2 | `algoScanner.ts:391`, `marketStreamer.ts:354,431` | Literal `$180` fallback harga SOL (di scanner untuk `avgTradeSizeSol`; di streamer `/180` ×2). M2 kemarin hanya fix impact gate. | kecil |
| m3 | `dexscreener.ts:100,215` | `priceChange5m: ... \|\| 0` — M7 tidak lengkap: unknown 5m momentum menjadi "terukur 0%" di source. Konsumen (`\|\| 0`) tetap fail-open. | kecil |
| m4 | `algoScanner.ts:318` | `bondingCurvePct = 50.0` saat curve fetch gagal → lolos funnel gate [15,85]. Fail-open di safety gate. | fail-open |
| m5 | `algoScanner.ts:298` | `tokenAgeSec = 600` default saat `pairCreatedAt` unknown → melewati gate anti-detik-0 (180s). Seharusnya `undefined` (funnel sudah handle undefined = skip… yang juga fail-open; lebih baik tolak). | fail-open |
| m6 | `algoScanner.ts:50,565` | `isExcluded` karantina ingestion masih substring `includes('SL')/includes('DUMP')` — miss `FLASH_EXIT_RUG_BUSTER`, `ZOMBIE_*`, `TIME_STOP`, `MAX_HOLD`. Buy-path sudah pakai `ExitClass` (aman), tapi inkonsisten — slot ingestion terbuang & jebakan laten jika buy-path berubah. | laten |
| m7 | — | `return15m`, `atrPct`, `breakoutDistancePct`, `avgTradeSizeUsd`, `tradeCount5m` dihitung tapi **tidak dipakai** scorer/entryEngine manapun. `return15m` jujur tapi mati. | dead |
| m8 | `opportunityScorer.ts` | Komponen `Liquidity`: upstream gate $35k → `min(35k/10k,4)/4 = 0.875` → ~17/20 poin untuk **semua** kandidat. Near-constant, tanpa daya diskriminasi. | dead weight |
| m9 | `opportunityScorer.ts` / `entryEngine.ts` | `Volatility` +8 untuk `HIGH_VOLATILITY` sementara hurdle +5 untuk regime yang sama (net +3, pesan campur: scorer reward vol, hurdle takut vol). | inkonsisten |
| m10 | `marketStreamer.ts:430` | Fallback `rvol5m = tickVelocity/4.0` memakai `tickCount` **kumulatif** (tak pernah direset) → jenuh di 10 untuk token aktif. Untungnya path WS tidak pernah buy. | dead-ish |
| m11 | `db/index.ts:822-825` | `getTradingStats` (display) pakai `positions.pnl_pct` gross. Display saja. | kosmetik |
| m12 | `adaptiveLearningEngine.ts` | `adaptEntryHurdleGated` pakai `trade_history.pnl_sol` (net of sell fee, **gross of buy fee** ~0.00035 SOL ≈ 0.7% wedge) — klasifikasi win/loss sedikit meleset di dekat nol. | kecil |
| m13 | `algoScanner.ts` (`ret1h ?? 0`) | Veto exhaustion `ret1h > 70 && ret5m < 0` tidak fire saat `priceChange1h` unknown (jadi 0). Veto fail-open. | fail-open |
| m14 | `dexscreener.ts` | `getMultiTokenMarketData`: chunk yang gagal (non-429) hilang diam-diam — s.d. 30 token skip satu siklus tanpa jejak selain warn. | robustness |
| m15 | `algoScanner.ts:392` | `avgTradeSizeUsd` fallback `$80` saat volume unknown → `netBuyFlowSolEst` dari angka tebakan. | kecil |
| m16 | `algoScanner.ts` (~:105) | Whale queue legacy masih di-ingest sebagai kandidat (M5 mencabut copy-sell tapi ingestion queue tetap). Kandidat tetap lewat gate penuh — dead concept. | hygiene |
| m17 | `algoScanner.ts` (sort) | `Math.max(0.1, momentum)` — semua token bermomentum negatif kolaps ke 0.1; tidak ada deprioritisasi dump dalam vs flat. | kecil |
| m18 | `marketStreamer.ts:333-346` | `await getSolPriceUsd()` tanpa try/catch di handler WS → unhandled rejection risk; jika return 0, `item.lastPriceUsd = 0` (tape menolak 0, tapi state item tercemar). | robustness |
| m19 | `algoScanner.ts` (`runAlgoScanCycle`) | Tidak ada guard overlap antar siklus; dua siklus yang overlap bisa lolos balance-check TOCTOU dan double-allocate (lock hanya per-token). Heat cap 50% membatasi, tapi celah desain. | laten |
| m20 | `tradeManager.ts:411` | `simulateRealisticBuy` fallback `safeLiquidityUsd = max(500, ...)` — di bawah gate tak masalah, tapi sim tidak pernah bisa menunjukkan impact > ~batas $500. | kecil |

---

## Yang sudah benar (diverifikasi, jangan diubah tanpa alasan)

- **Tidak ada race double-entry in-process.** WS path (`evaluateWatchlistCandidateOnTick`) secara eksplisit
  **tidak pernah** memanggil `executeBuyToken` — hanya telemetri + promosi watchlist. Lock `activeOrderTokens`
  sound: tidak ada `await` antara `has` dan `add` (`tradeManager.ts` ~:205-245), dan `finally` selalu melepas.
  (Duplikat **antar-proses** tetap ranah audit operasional/watchdog.)
- **Perbaikan C1–C4/M2/M5/M7 terverifikasi di tempat**: tape immature → skip (`algoScanner.ts` ~:490);
  karantina unindexed (`:290`); ratio undefined fail-closed (`:364`, `:433`); `volumeAcceleration` undefined
  fail-closed di scorer (`opportunityScorer.ts`) dan R1 (`entryEngine.ts`).
- **Karantina 24h buy-path** memakai `ExitClass` (`tradeManager.ts` ~:230) — termasuk `FLASH_EXIT`.
- **Risk choke point tunggal**: `executeBuyToken` dipakai scanner **dan** manual Telegram (`telegram.ts:1240`) —
  quarantine, heat cap MTM, daily equity stop, narrative shield, circuit breaker berlaku untuk keduanya. Manual
  sniper by-design bypass scoring (bukan bug).
- **`simulateRealisticBuy`**: quote Jupiter konservatif (`otherAmountThreshold`), fee venue-aware
  (pump 1.25% vs Raydium 0.25%), network fee live. `prefetchedMarketData` tidak dipakai scanner (re-fetch fresh).
- **Kelly** dari `net_pnl_sol` (F-04) — kecuali wedge kecil di m12 dan inkonsistensi M9.

---

## Rekomendasi prioritas fix (estimasi effort)

1. **M1+M2** (tape: `minutesSincePrevPoint`, `minutesBetweenVolumePoints` + normalisasi 5-menit) — 1 file, menutup
   2 bug terbesar + ripple ke R1/scorer/signal. **Paling urgent.**
2. **M12** (satu baris `>= 1.5`) — trivial.
3. **M4** (journal `EVALUATED` saat scan, `EXECUTED` hanya saat fill sukses) — tanpa ini, fitting bobot offline
   di atas data palsu.
4. **M3** (re-validasi entryEngine di `executeBuyToken` dengan data fresh).
5. **M5+M6** (funnel: ukur real atau hapus stage; hentikan pelabelan "real" untuk angka formula).
6. **M7** (`fetchedAt` + tolak buy basi), **M9** (streak dari `net_pnl_sol`), **M10** (fail-closed depth),
   **M8** (cabut/hard-tag boosted), **M11** (kebijakan consensus bonus).
7. Minor m1–m20 opportunistically.

**Catatan paper-P&L:** semua temuan di atas (kecuali M4/M8/M11/M9-sebagian) mengarah ke **paper yang optimistis**:
gate dilemahkan (M1, M2, M12), fill di harga basi (M7), depth ditebak (M10), keputusan basi (M3).
Setelah fix, harapkan **frekuensi entry turun** — itu fitur, bukan bug. Jangan turunkan hurdle 75 untuk
"mengembalikan" frekuensi.
