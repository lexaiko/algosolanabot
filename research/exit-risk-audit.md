# Audit Exit & Risk Engine — 29 Sep 2026

**Auditor:** subagent independen (read-only — tidak ada kode/DB/.env yang diubah)
**Scope:** seluruh jalur exit & risk — `src/services/tradeManager.ts` (evaluatePosition, executeSellToken, ratchet, zombie reaper, circuit breaker, daily stop, heat cap, closePosition), `src/services/dexSimulator.ts` (realisme sell), `src/db/index.ts` (akuntansi paper balance, trade_history), `src/config.ts` (validasi ambang), `src/execution/positionManager.ts` (mirror backtest), plus `src/services/backtester.ts`, `src/strategies/adaptiveLearningEngine.ts`, `src/bot/telegram.ts` yang tersentuh jalur exit.
**Metode:** baca source penuh fungsi-fungsi di atas, verifikasi tiap klaim di kode (bukan dari komentar), lacak aliran data antar modul.

**Verdict ringkas:** jalur eksekusi inti (double-sell lock, ordering closePosition→balance, class-based phantom guard, emergency slippage, breaker counting, Kelly net, MTM heat/daily stop, fee unification) sudah benar pasca-fix 29 Sep. Cacat yang tersisa terbanyak ada di **tiga keluarga**: (1) angka **gross-vs-net** yang bocor ke keputusan risk (loss streak, hurdle adaptasi, breaker count, attribution), (2) **backtest & dokumentasi user** yang masih menjalankan/menggambarkan strategi pensiun, (3) **fabrikasi likuiditas $500** di simulator dan **knob config mati/berbahaya**.

---

## CRITICAL

### C-1. Telegram `/backtest` menjalankan STRATEGI YANG SUDAH PENSIUN dengan fee model yang menghilangkan DEX fee
- **File:** `src/services/backtester.ts:205-237` (Stage 1 TP 50% + moonbag trailing -12%), `:308-312` (fee), dipanggil user via `src/bot/telegram.ts:28-33` (tombol "🔬 Backtester" / `/backtest`).
- **Kenapa cacat:** Modul ini masih mengimplementasikan Half-TP/moonbag yang sudah dihapus dari produksi (produksi = 100% single-exit ratchet). Lebih parah: fee model-nya `fees = ESTIMATED_SELL_FEE_SOL` (0.00025 SOL network saja) — **DEX fee 1.25%/side (pump) / 0.25%/side (Raydium) tidak dihitung sama sekali**, dan tidak ada slippage/price-impact — exit selalu fill tepat di `candle.low`/`close`.
- **Dampak ke P&L:** Pada posisi 0.05 SOL, round-trip fee riil ≈ 0.0018 SOL; backtester hanya hitung 0.00025–0.0006 SOL → **biaya understated ~3-7x**. Setiap angka win-rate/PF/expectancy dari menu ini adalah fiksi untuk strategi yang tidak dijalankan bot. Keputusan sizing/kepercayaan diri berbasis ini salah arah.
- **Fix konkret:** (a) Tandai command deprecated di Telegram, atau (b) tulis ulang `runBacktest` di atas `positionManager.evaluatePositionExit` (mirror yang sudah sinkron) + terapkan `estimateRoundTripFeePct` dan adverse-slip model dari `dexSimulator` per bar. Jangan biarkan dua mesin backtest dengan logika berbeda hidup berdampingan.

---

## MAJOR

### M-1. Simulator mengarang likuiditas $500 saat depth tidak diketahui
- **File:** `src/services/dexSimulator.ts:147` (sell) dan `:244` (buy): `const safeLiquidityUsd = Math.max(500, poolLiquidityUsd);`
- **Kenapa cacat:** `executeSellToken` (tradeManager.ts:741-744) dengan bangga tidak lagi memalsukan depth $20000 dan meneruskan `effLiquidity = 0` saat likuiditas unknown — tapi simulator diam-diam mengubah 0 → 500. Pool $500 ($250 sisi SOL) lalu dipakai di rumus constant-product menghasilkan fill yang terlihat wajar untuk posisi ~0.05 SOL.
- **Dampak ke P&L:** Posisi yang di dunia nyata **tidak bisa dijual** (pool kering / data mati) tercatat exit bersih di paper. Ini optimisme sistematis tepat di skenario terburuk (rug), dan melanggar prinsip "no invented depth" yang sudah ditegakkan di tempat lain.
- **Fix konkret:** Jika `poolLiquidityUsd <= 0`, kembalikan `{ success: false, netSol: 0, warning: 'LIQUIDITY_UNKNOWN' }`; `executeSellToken` harus menolak menyelesaikan exit (kecuali darurat yang dicatat eksplisit sebagai `STALE_LIQUIDITY_FILL`) dan menjadwalkan retry — bukan mengarang fill.

### M-2. Mirror backtest divergen dari produksi di dua aturan exit
- **File:** `src/execution/positionManager.ts:66` (flash `dropPct >= 30.0`) vs `src/services/tradeManager.ts:1057` (produksi: `dropPct >= 50.0 && currentLiquidityUsd < 12000`); `positionManager.ts:153` (`hoursHeld >= 12.0`) vs produksi `CONFIG.MAX_HOLD_TIME_HOURS` (24).
- **Kenapa cacat:** Klaim docstring "MIRRORS tradeManager.evaluatePosition" salah di dua titik. Backtest keluar dari rug di -30% padahal produksi menunggu -50% + collapse di bawah $12k → **backtest understated kerugian rug**. Max-hold 12h vs 24h menggeser timing semua exit timeout. (Bonus: `CONFIG.FLASH_EXIT_DROP_PCT` = 30% **mati total di produksi** — knob ada, teks Telegram mengklaim ">30%", tapi kode hardcode 50%.)
- **Dampak ke P&L:** Semua metrik backtest bias optimis di skenario rug; keputusan "strategi ini selamat dari rug" tidak valid.
- **Fix konkret:** Mirror harus membaca `CONFIG.FLASH_EXIT_DROP_PCT` + syarat `$12k` + `prevLiq > $5000`, dan `CONFIG.MAX_HOLD_TIME_HOURS` — atau sebaliknya produksi memakai `CONFIG.FLASH_EXIT_DROP_PCT` agar knob hidup. Satu sumber kebenaran, bukan dua angka hardcode.

### M-3. Ratchet cliff: peak 44.9% vs 45.0% → perbedaan proteksi ~38pp
- **File:** `src/services/tradeManager.ts:1125-1143` (tier boundaries 22/45/80/150).
- **Kenapa cacat:** Peak +44.9% → tidak ada floor (boleh round-trip sampai SL -9.5%, total ayunan ~54pp). Peak +45.0% → floor `max(25, 45-trail)+fee` ≈ +28.7% net. Perbedaan pengukuran 0.1pp (noise satu tick) mengubah hasil trade sebesar ~38pp. Ini bukan risk management, ini lotre tick.
- **Dampak ke P&L:** Trade yang "hampir" mencapai tier secara rutin kehilangan seluruh run-up; distribusi hasil punya diskontinuitas buatan di tiap boundary.
- **Fix konkret:** Buat floor kontinu untuk `peak >= 22`: `floor(peak) = max(guarantee(peak), peak - trail(peak)) + feeBuffer`, dengan `guarantee` ramp linear 3.5% → 25% di zona [22,45), lalu 25/50/100 sebagai batas bawah per segmen. Tidak ada lompatan di boundary mana pun. (Ini redesign yang ditunda sebagai F-09 — sekarang ada spesifikasinya.)

### M-4. Harga basi bisa memicu emergency exit yang dieksekusi di harga basi
- **File:** `src/services/tradeManager.ts:1036-1043` (evaluasi jalan di `pos.current_price_usd` saat `getTokenMarketData` null), `:748-756` (emergency boleh jual di `pos.current_price_usd` yang basi).
- **Kenapa cacat:** Jika DexScreener mati (return null), `evaluatePosition` tidak abort — ia mengevaluasi posisi di harga terakhir yang diketahui. Jika harga basi itu menunjukkan ≤ -9.5%, `AUTO_SL` (EMERGENCY) terpicu dan `executeSellToken` mengeksekusi **di harga basi tersebut**. Non-emergency aman (diblokir stale-guard), tapi semua alasan emergency lolos.
- **Dampak ke P&L:** Skenario rug asli: harga → 0, feed mati, bot "menjual" di harga terakhir pra-rug → paper mencatat recovery fiktif. Optimisme sistematis tepat saat bencana. (Keluarga F-12 yang ditunda.)
- **Fix konkret:** Jika `!marketDataValid`, jangan trigger exit berbasis harga sama sekali — tandai posisi `STALE_FEED`, coba fallback RPC/on-chain (sudah ada untuk pump, belum untuk Raydium), dan hanya izinkan emergency exit jika ada konfirmasi harga independen kedua. Catat `STALE_PRICE_FILL` di reason agar terlihat di audit.

### M-5. Loss-streak defense (anti-martingale sizing) dihitung dari pnl_pct GROSS
- **File:** `src/db/index.ts:602-617` (`getConsecutiveAlgoLosses`: `SELECT pnl_pct ...`, `if (r.pnl_pct <= 0) streak++ else break`).
- **Kenapa cacat:** `pnl_pct` di tabel positions adalah return harga gross. Trade +0.5% gross / -2.5% net (wajar dengan fee ~3%) dihitung **WIN** dan me-reset streak. `getDynamicAlgoBuyAmount` lalu tidak menerapkan decay 0.75^streak.
- **Dampak ke P&L:** Pertahanan anti-martingale lumpuh tepat saat strategi berdarah net — sizing tetap penuh di tengah net-loss streak. Ini knob sizing yang salah baca, dampaknya compounding.
- **Fix konkret:** Hitung streak dari `trade_history.net_pnl_sol` (net of fees, sudah ada kolomnya): `SELECT net_pnl_sol FROM trade_history WHERE action='SELL' ORDER BY id DESC LIMIT 10`, streak saat `net_pnl_sol <= 0`.

### M-6. Adaptasi hurdle entry memakai pnl_sol GROSS
- **File:** `src/strategies/adaptiveLearningEngine.ts:205-225` (`adaptEntryHurdleGated`: `SELECT pnl_sol ...`, `r.pnl_sol > 0` = win).
- **Kenapa cacat:** `pnl_sol` = net of sell-side fee saja, gross of buy fee (0.00035). Trade marginal (+0.0002 gross, net negatif) dihitung win → win-rate 15-trade terakhir bias optimis → hurdle entry (satu-satunya parameter yang diadaptasi online!) bergerak ke arah yang salah: dilonggarkan saat seharusnya diperketat.
- **Dampak ke P&L:** Selektivitas entry — gerbang utama edge — dikalibrasi oleh meter yang rusak. Efeknya lambat (±2 pts per adaptasi, butuh ≥30 trade) tapi sistematis.
- **Fix konkret:** `SELECT net_pnl_sol FROM trade_history WHERE action='SELL' ...`, win = `net_pnl_sol > 0`.

### M-7. Fee buffer ratchet buta venue: 2.5% untuk semua, Raydium seharusnya 0.5%
- **File:** `src/services/tradeManager.ts:87-95` (`dexFeePct = 2 * 1.25`), mirror sama di `positionManager.ts:14-19`. Padahal `dexSimulator.ts:78,202` sudah venue-aware (pump 1.25%, Raydium 0.25%).
- **Kenapa cacat:** Klaim "floor NET of fees" salah ~2pp untuk semua posisi Raydium (buffer 3.7% vs seharusnya ~1.7% di posisi 0.05 SOL). Floor Tier-1 jadi 7.2% bukan 5.2%.
- **Dampak ke P&L:** Semua exit ratchet Raydium terpicu ~2pp lebih awal → whipsaw prematur di pasar choppy (keluar sebelum run selesai). Arahnya over-konservatif, tapi "NET"-nya fiksi.
- **Fix konkret:** `estimateRoundTripFeePct(entrySol, isPump: boolean)` — panggil dengan `tokenMint.endsWith('pump')`, samakan dengan logika venue di dexSimulator. (Keluarga F-10 yang ditunda.)

### M-8. Knob config paling berbahaya tidak lewat validasi `numPos`
- **File:** `src/config.ts:62` (`MAX_HOLD_TIME_HOURS: Number(...) || 24`), dan `DAILY_MAX_LOSS_PCT`, `MAX_PORTFOLIO_HEAT_PCT`, `KELLY_FRACTION`, `ESTIMATED_*_FEE_SOL`, dsb. Fungsi `numPos` (config.ts:11-25) ada persis untuk mencegah ini tapi hanya dipakai sebagian knob.
- **Kenapa cacat:** `MAX_HOLD_TIME_HOURS=-1` → truthy → `hoursHeld >= -1` selalu benar → **semua posisi langsung di-reap sebagai TIME_STOP**. `DAILY_MAX_LOSS_PCT=-0.08` → entry beku permanen. Satu baris `.env` typo = bunuh diri bot.
- **Dampak ke P&L:** Total (likuidasi seluruh book / freeze total) dari kesalahan konfigurasi sepele.
- **Fix konkret:** Lewatkan SEMUA knob numerik risk melalui `numPos` (tambahkan validasi rentang khusus di mana perlu, mis. fraksi 0..1).

### M-9. Teks strategi di Telegram menggambarkan strategi yang tidak ada
- **File:** `src/bot/telegram.ts:1096-1100`: "Stage 1 Take-Profit +45% (Jual 50% & Kunci Modal)", "Stage 2 Moonbag Trailing Stop -12% dari ATH", "Flash-Exit: likuiditas hilang >30%". Realita: 100% single-exit ratchet; flash butuh 50% + <$12k.
- **Kenapa cacat:** User mengambil keputusan (dan menilai performa bot) berdasarkan deskripsi strategi yang salah.
- **Dampak ke P&L:** Tidak langsung ke angka, tapi ini misrepresentasi produk ke satu-satunya operator.
- **Fix konkret:** Tulis ulang blok "Exit & Proteksi Profit" sesuai ratchet aktual: tier +22/+45/+80/+150, floor net-of-fees, hard SL -9.5%, zombie 2.5h, flash 50%/<$12k.

---

## MINOR

### m-1. Phantom guard memakai harga post-impact, mencampuradukkan "feed palsu" vs "pool tipis"
- **File:** `src/services/tradeManager.ts:778-784` — guard membandingkan `effectiveExitPriceUsd` (setelah impact+slip) dengan entry.
- **Skenario:** Peak +23% (Tier-1 armed), likuiditas drain 40% (di bawah ambang flash 50%), harga jatuh ke floor +6.5% mid → ratchet fire → impact 10% → effective -2.5% → **guard BLOCK** → posisi bertahan → jatuh ke SL -9.5%. Lock "+6.5% tidak akan pernah rugi" berubah menjadi -9.5% karena guard salah mendiagnosis pool tipis sebagai spike palsu.
- **Catatan jujur:** Dengan filter entry `MIN_LIQUIDITY_USD $30k` dan ukuran posisi ~0.05 SOL, skenario ini jarang — dan guard saat ini benar melawan spike DexScreener palsu yang persisten. Ini trade-off, bukan bug murni.
- **Fix:** Saat guard fire, log `priceImpactPct` dan `effLiquidity` (sebagian sudah ada) + counter metrik; pertimbangkan guard pada pre-impact mid-price untuk exit yang trigger-nya terverifikasi di atas entry.

### m-2. Zombie reaper punya dead zone [-9.5%, -6%)
- **File:** `src/services/tradeManager.ts:1150-1156` — band `pnlPct >= -6.0`, sedangkan hard SL -9.5%. Posisi -8% stagnan 20 jam tidak disentuh reaper maupun SL — modal mati yang justru diciptakan untuk didaur ulang.
- **Fix:** Turunkan batas bawah zombie ke -9.0% (atau selaraskan dengan SL), atau dokumentasikan sebagai keputusan desain.

### m-3. Klasifikasi win/loss attribution memakai pnlPct gross
- **File:** `src/strategies/adaptiveLearningEngine.ts:143`: `const isWin = outcome.netPnlSol > 0 || outcome.pnlPct > 0;` — trade net-negatif tapi gross-positif dihitung WIN (tambah `wins`, `gross_profit_sol += 0`).
- **Dampak saat ini:** attribution `win_rate`/`profit_factor` hanya informasional (bobot strategi dibekukan sampai 200 sampel) — kerusakan terbatas, tapi log `[SelfLearning]` menampilkan WR/PF yang salah.
- **Fix satu baris:** `const isWin = outcome.netPnlSol > 0;`

### m-4. `targetTp` dekoratif — di-assign, tidak pernah dibaca exit logic
- **File:** `src/services/tradeManager.ts:1088` (`const targetTp = ...` tidak direferensikan lagi di `evaluatePosition`); Telegram menampilkan "Target TP: +45%" (tradeManager.ts:659).
- **Fix:** Hapus variabel mati + label Telegram, atau implementasikan TP sebagai tier ratchet (keputusan desain).

### m-5. Knob mati yang menyesatkan
- `MAX_CONSECUTIVE_LOSSES` (4), `MAX_LIQUIDITY_DEPTH_PCT` (1.5%) — **tidak pernah dibaca** di mana pun (`grep` nol hasil di luar config). Klaim "never exceed 1.5% of pool depth" tidak ada implementasinya.
- `VOLATILITY_ADAPTIVE_EXITS`, `TRAILING_STOP_PCT` — mati di produksi, hanya hidup di backtester legacy.
- **Fix:** Hapus dari config, atau implementasikan. Knob mati = janji palsu + jebakan audit berikutnya.

### m-6. Mirror backtest memakai literal harga SOL $150
- **File:** `src/execution/positionManager.ts:48`: `position.pnlUsd = (position.entrySol * 150) * ...` — dosa M3 (literal $150/$180) yang sama, versi mirror.
- **Fix:** Teruskan `solPriceUsd` sebagai parameter seperti produksi.

### m-7. `updatePaperBalance` clamp ke nol menyembunyikan bug akuntansi
- **File:** `src/db/index.ts:190-196`: `Math.max(0, current + amountDelta)`. (F-13 yang ditunda.) Jika ada bug double-debit, saldo diam-diam dijepit 0 dan rekonsiliasi vs `trade_history` mustahil.
- **Fix:** Log `console.error` + alert Telegram saat clamp aktif, dengan delta yang dijepit.

### m-8. Breaker menghitung loss dari pnl_sol GROSS
- **File:** `src/db/index.ts:905-924`: `pnl_sol < 0` (gross of buy fee). Trade +0.0001 gross / net-negatif tidak kehitung sebagai loss harian.
- **Fix:** `net_pnl_sol < 0`, konsisten dengan filosofi net yang sudah dipakai di Kelly (F-04).

---

## Yang sudah benar (diverifikasi manual, bukan dari komentar)

- **Double-sell:** `sellingPositionIds` lock + re-validasi status di dalam lock + `evaluatingPositions` guard + cek pra-tulis — empat lapis, benar.
- **Ordering:** `closePosition` sebelum `updatePaperBalance`; jika close gagal, saldo tidak dikredit.
- **Phantom guard class-based** (F-01), **emergency slippage path** (F-02), **breaker forced-loss counting** (F-03), **Kelly dari net_pnl_sol** (F-04), **heat cap & daily stop MTM** (F-05), **unifikasi fee** (F-07/F-08), **max-hold via CONFIG** (F-11) — semua terkonfirmasi di kode.
- **Flash-wick filter berjalan SEBELUM `updatePositionPrice`** — spike palsu tidak pernah menyentuh peak. Benar.
- **`notify()` throw-safe** (try/catch internal) — skenario "notify gagal → breaker tidak trip" tidak mungkin terjadi.
- **Heartbeat:** konkurensi dibatasi 5, per-position isolation, WS-silence fallback 35s/6s. Wajar.
- **Akuntansi round-trip:** debit buy (principal + live fee + ATA) vs kredit sell (netSol + refund ATA) — ATA net-nol di kedua sisi, `trade_history` dan balance rekonsiliasi dalam batas selisih estimasi fee (tercatat, kecil).
- **realFeeEngine** punya `FALLBACK_FLOOR` — tidak pernah mengembalikan fee 0 diam-diam.

## Residual / belum bisa dibuktikan

- **Frekuensi aktual M-4** (stale feed) dan **m-1** (guard vs impact) butuh data insiden — sarankan counter metrik sebelum mengubah perilaku.
- **Klaim "Tier-1 tidak akan pernah rugi"** secara formal salah di 3 skenario (m-1, gap melewati floor + impact ekstrem, stale-price emergency) — floor adalah jaminan mid-price, bukan jaminan fill.
- Backtest mirror belum memodelkan biaya DEX & slippage sama sekali di sisi sinyal — angka backtest mana pun (termasuk yang dikutip di MEMORY) harus dibaca dengan diskonto ini sampai C-1/M-2 diperbaiki.
- Tidak ada test deterministik untuk transisi state exit (diserahkan ke parent untuk harness).
