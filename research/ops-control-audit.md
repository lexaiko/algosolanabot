# Audit Ops & Control Plane — algosolanabot

Tanggal: 29 Sep 2026 · Auditor: subagent ops/control (read-only, tidak ada kode diubah)
Cakupan: `src/bot/telegram.ts`, `src/index.ts`, `src/config.ts`, decision journal,
counterfactual tracker, error handling global, rate-limit/retry, watchdog interplay,
`.env.example` vs kebutuhan nyata.

**Ringkasan eksekutif:** bidang eksekusi inti (exit/risk, data integrity) sudah
diperbaiki di batch sebelumnya, tetapi **lapisan kontrol/operasional masih punya
2 cacat CRITICAL**: (1) watchdog bisa memicu **double-instance** yang berbagi satu
SQLite tanpa WAL/busy_timeout — korupsi data & double-buy; (2) decision journal
mencatat `EXECUTED` untuk buy yang **belum tentu terjadi**. Ditambah 10 temuan
MAJOR, mayoritas berupa **klaim menyesatkan di UI Telegram** (model exit lama yang
sudah mati masih dipajang) dan **mode gagal-diam** (alert hilang, validasi config
bolong, zombie process yang dianggap watchdog "hidup").

---

## CRITICAL

### O-01 — Watchdog check+start tidak atomik → risiko double-instance berbagi satu SQLite
- **File:** definisi cron `algosolanabot-watchdog` (langkah 1 vs langkah 2), diperparah
  `src/db/index.ts:8` (`new DatabaseSync(dbPath)` tanpa WAL / busy_timeout).
- **Kenapa cacat:** body cron mengklaim "SELURUH cek+start harus atomik via flock",
  tetapi `flock -n` hanya membungkus **langkah 1 (cek)**. **Langkah 2 (restart +
  verifikasi ~45 dtk) berjalan di luar lock.** Dua run yang overlap (cadence 5 mnt,
  timeout 120 dtk, tiap run bisa >75 dtk karena sleep 30 + verifikasi 45) bisa
  sama-sama melihat `DEAD` lalu sama-sama `setsid nohup npx tsx src/index.ts` →
  **dua proses bot hidup bersamaan**.
- **Dampak operasional:** kedua instance memakai `tradingbot.db` yang sama via
  `node:sqlite` tanpa `busy_timeout` dan tanpa WAL → `SQLITE_BUSY` crash acak pada
  write contention; balance dibaca basi antar-proses → **double-buy token yang sama
  dan double-spend paper balance** (cek `getOpenPositionByToken` tidak atomik lintas
  proses); dua poller Telegram berebut update (409 Conflict, salah satunya retry
  selamanya); posisi bisa dijual dua kali (lock `sellingPositionIds` hanya in-memory
  per proses).
- **Perbaikan konkret:**
  1. Bungkus cek+start dalam **satu** `flock` tunggal (satu skrip shell, bukan dua
     langkah terpisah di body cron).
  2. Tambahkan singleton guard di dalam bot: lock file eksklusif (`fs.openSync`
     + `flock`) atau PID file yang dicek saat startup; instance kedua exit(1).
  3. `db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')` di `initDatabase`.
  4. Watchdog verifikasi **tepat 1** instance (`pgrep -c`), bunuh duplikat bila >1.

### O-02 — Journal mencatat `EXECUTED` padahal buy belum tentu tereksekusi
- **File:** `src/services/algoScanner.ts:656`
  (`decision: isPassed ? 'EXECUTED' : 'SKIPPED'`), vs `runAlgoScanCycle`
  (`src/services/algoScanner.ts:690-734`).
- **Kenapa cacat:** `EXECUTED` ditulis saat kandidat **lolos scan**, tetapi
  `executeBuyToken` setelahnya masih bisa gagal (saldo kurang, heat cap, daily stop,
  circuit breaker, karantina token, safety check). Journal tidak pernah dikoreksi.
  5 `EXECUTED` di journal saat ini kebetulan cocok dengan 5 fill nyata — semantiknya
  tetap salah dan akan menggelembung saat buy gagal.
- **Dampak operasional:** dataset counterfactual/falsifikasi terkontaminasi baris
  `EXECUTED` tanpa fill → evaluasi "apakah penolakan/eksekusi benar" jadi tidak
  valid; Eko bisa salah menyimpulkan win-rate strategi.
- **Perbaikan konkret:** tulis `PASSED`/`PENDING` saat scan; update ke `EXECUTED`
  (dengan position id) hanya setelah `executeBuyToken` sukses, atau `FAILED` +
  reason bila gagal. Tambahkan kolom `position_id`, `executed_at`.

---

## MAJOR

### O-03 — UI Telegram masih memajang model exit lama yang sudah mati (klaim menyesatkan)
- **File:** `src/bot/telegram.ts:231` (`/start`), `:1104-1107` (`/settings`),
  `:768-772` (`/positions`: badge `STAGE 2 MOONBAG` / `Menuju TP1`,
  `Target TP (+45%)` dari `p.target_tp_pct`).
- **Kenapa cacat:** teks mengklaim "Stage 1 TP (+42%/+45%) kunci 50% modal" +
  "Stage 2 Moonbag Trailing Stop (-18%/-12%)". Engine aktual: **ratchet 100% di
  tier +22/+45/+80/+150, tanpa partial close** (half-TP sudah dihapus; F-14
  mencatat `target_tp_pct` dekoratif dan tak pernah dibaca exit engine).
- **Dampak:** Eko mengambil keputusan (mis. ekspektasi "50% modal aman di +45%")
  dari angka yang tidak terjadi di mesin. Ini kategori pesan yang berbohong.
- **Perbaikan:** tulis ulang ketiga surface agar menjelaskan tier ratchet aktual
  (+22/+45/+80/+150, trailing adaptif, SL -9.5%, zombie reaper 24 jam); hapus
  semua badge "MOONBAG"/"TP1".

### O-04 — `/start` melabeli PnL GROSS sebagai "Total Realized Net PnL"
- **File:** `src/bot/telegram.ts:226` memanggil `getTradingStats()`
  (`src/db/index.ts:821-836`) yang menjumlah `positions.pnl_pct/pnl_usd` —
  **murni price return, gross of fee** (dikonfirmasi docstring F-04 di
  `getEmpiricalKellyStats`).
- **Dampak:** dashboard menampilkan angka laba yang sistematis lebih optimistis
  ~2.9–3.7% round-trip fee per trade; keputusan "strategi profit" bisa salah.
- **Perbaikan:** hitung dari `trade_history.net_pnl_sol` (sudah true-net pasca
  F-07/F-08) seperti `getDailyRealizedPnl`; atau ganti label jadi "Gross".

### O-05 — `/start` mengklaim "Scanner Siklus 60s Aktif", aktual 10 menit
- **File:** `src/bot/telegram.ts:217` vs `src/services/algoScanner.ts:184`
  (`SCAN_INTERVAL_MS = 10 * 60 * 1000`).
- **Perbaikan:** sesuaikan teks ("siklus 10 mnt; trading live via MarketStreamer WS").

### O-06 — Tombol "🔄 Reset Saldo 10 SOL" me-reset ke 1.0 SOL
- **File:** `src/bot/telegram.ts:248` (label) vs `:1189`
  (`resetPaperBalance(CONFIG.INITIAL_PAPER_BALANCE_SOL)`, default `1.0` di
  `src/config.ts:40`).
- **Dampak:** Eko menekan tombol bertuliskan 10 SOL, saldo jadi 1.0 SOL — klaim
  palsu di tombol aksi destruktif.
- **Perbaikan:** label dinamis: `` `🔄 Reset Saldo ${CONFIG.INITIAL_PAPER_BALANCE_SOL} SOL` ``.

### O-07 — `uncaughtException`/`unhandledRejection` membuat proses tetap hidup → zombie yang dianggap watchdog "sehat"
- **File:** `src/index.ts:44-56`.
- **Kenapa cacat:** handler log lalu **menjaga proses hidup**. Jika state korup
  (WS streamer mati, heartbeat throw tiap 2 dtk, subscription yatim), watchdog
  hanya cek `pgrep` → melihat proses hidup → **tidak pernah restart**. Bot jadi
  zombie: terlihat online, tidak trading dengan benar, tidak ada alert.
- **Perbaikan:** pada `uncaughtException`, kirim alert admin lalu `process.exit(1)`
  agar watchdog restart; atau tulis health-file timestamp tiap loop sehat dan
  watchdog cek freshness-nya (staleness > N menit = DEAD).

### O-08 — ~20 parameter config memakai `Number()` mentah tanpa validasi positivitas
- **File:** `src/config.ts` — `MAX_HOLD_TIME_HOURS`, `MIN_TOKEN_AGE_SEC`,
  `MAX_TOKEN_AGE_HOURS`, `MAX_5M_PRICE_CHANGE_PCT`, `INITIAL_PAPER_BALANCE_SOL`,
  `BONDING_CURVE_*`, `MIN_UNIQUE_HOLDERS`, `MAX_DEV_HOLDING_PCT`, dsb.
  (hanya sebagian yang memakai `numPos`).
- **Kenapa cacat:** `Number('-5')` truthy → lolos. Contoh: `MIN_TOKEN_AGE_SEC=-1`
  menonaktifkan filter anti-detik-0; `MAX_HOLD_TIME_HOURS=-5` membunuh setiap
  posisi seketika; `INITIAL_PAPER_BALANCE_SOL=-3` start dengan saldo negatif.
  Satu typo di `.env` = perilaku berbahaya diam-diam (hanya `console.warn` untuk
  yang memakai `numPos`; yang lain bahkan tidak warning).
- **Perbaikan:** lewatkan **semua** parameter numerik risiko/ukuran lewat `numPos`
  (atau `numRange` dengan batas min/max); pertimbangkan `process.exit(1)` untuk
  nilai invalid pada parameter kritis, bukan fallback diam-diam.

### O-09 — Alert kritis bisa hilang diam-diam (tanpa antrian/retry)
- **File:** `src/bot/telegram.ts:80-113` (`sendAdminAlert`): loop watcher
  fire-and-forget (`.catch` menelan); `startTelegramWithRetry`
  (`src/index.ts:63-91`) retry selamanya bila token salah — **bot tetap trading
  tanpa Telegram**.
- **Dampak:** circuit breaker, sell darurat, error fatal — semua bisa tidak sampai
  ke Eko tanpa jejak.
- **Perbaikan:** antrian notifikasi persisten (tabel `outbox`) dengan retry
  backoff; self-test message saat startup ("bot online, mode PAPER"); bila
  `getMe()` gagal N kali, hentikan autonomous buy (fail-closed) atau bunyikan
  lewat kanal cadangan.

### O-10 — `TELEGRAM_ADMIN_ID` kosong → 0 → tidak ada admin, bot tetap trading
- **File:** `src/config.ts:34` (`Number(...) || 0`); `src/bot/telegram.ts:134`
  (`isAdmin` falsy untuk semua orang bila 0); `sendAdminAlert` diam bila 0.
- **Dampak:** deploy baru tanpa ADMIN_ID = trading otonom dengan **nol oversight**,
  nol alert, dan semua tombol admin mati (termasuk `/kick` darurat).
- **Perbaikan:** saat startup, bila `TELEGRAM_ADMIN_ID` 0 → log FATAL dan
  nonaktifkan autonomous buy sampai diisi (atau `process.exit(1)` bila
  `REQUIRE_TELEGRAM_ADMIN=true`).

### O-11 — Menu watcher menjanjikan `/scan`, perintahnya menolak watcher
- **File:** `src/bot/telegram.ts:183` (teks "Menu yang bisa kamu akses: /scan…")
  vs `handleScanCommand` (`:284-292`) + middleware RBAC (`:148-153`) yang
  menolak non-admin.
- **Perbaikan:** hapus `/scan` dari menu watcher, atau buka versi read-only
  (tanpa tombol buy).

### O-12 — `dropPendingUpdates: true` membuang perintah user yang dikirim saat restart
- **File:** `src/index.ts:78`.
- **Dampak:** user menekan "✅ Ya, Jual 100%" tepat saat bot restart → update
  dibuang diam-diam; user mengira perintah gagal padahal niat cut-loss hilang.
- **Perbaikan:** jangan drop; atau setelah launch kirim pesan "bot baru restart,
  silakan ulangi perintah terakhir bila belum tereksekusi".

---

## MINOR

- **O-13** — `src/bot/telegram.ts:711`: teks posisi kosong menyebut "skor ≥ 70",
  hurdle aktual 75 (`adaptiveLearningEngine.ts:73`). Sesuaikan.
- **O-14** — `src/bot/telegram.ts:768`: `estFeeSol = 0.002` hardcode di kalkulasi
  Net /positions (8× `CONFIG.ESTIMATED_SELL_FEE_SOL=0.00025`). Pakai CONFIG.
- **O-15** — `src/bot/telegram.ts:888`: badge `/report` — SELL rugi via MANUAL
  dilabel `🔴 SL`, TIME_STOP profit dilabel `🟢 TP`. Label dari `ExitClass`/reason,
  bukan tanda pnl.
- **O-16** — `/quant` menampilkan Sharpe/Sortino berlabel "INSTITUTIONAL" untuk
  n=5 trade (`quantMetrics.ts:32,51` hanya guard n<2). Tambahkan caveat
  "sampel kecil — belum signifikan" bila n<30.
- **O-17** — `.env.example` basi & menyesatkan: `COPY_SELL_ENABLED=true`
  (config mati — tak ada reader — dan bertentangan dengan pencabutan whale-follow
  M5); `INITIAL_PAPER_BALANCE_SOL=10.0` vs default kode 1.0;
  `MAX_CONSECUTIVE_LOSSES=2` vs 4; `MIN_WINRATE_PCT=50.0` vs 40.0;
  `POSITION_CHECK_INTERVAL_SEC=10` vs 2; ~15 var yang dibaca kode tidak ada di
  example (`JITO_*`, `KELLY_*`, `DAILY_MAX_LOSS_PCT`, `MAX_PORTFOLIO_HEAT_PCT`,
  `ESTIMATED_*_FEE_SOL`, `FLASH_EXIT_*`, `CABAL_*`, …); placeholder
  `TELEGRAM_ADMIN_ID=your_telegram_admin_id_here` → `Number()` = NaN → 0 diam-diam.
- **O-18** — `counterfactualTracker.ts`: `getRecentDecisions(25)` hanya memproses
  25 keputusan **terbaru** — saat scanner log puluhan keputusan/siklus, keputusan
  lama yang belum terisi bisa kelaparan; `stopCounterfactualTracker` tidak
  membatalkan `setTimeout(trackOnce, 60s)` awal. (Kejujuran data per-bucket sudah
  baik — ini murni throughput/shutdown.)
- **O-19** — `src/services/marketStreamer.ts:387,697`: `liquidityUsd / 180`
  (literal harga SOL) dan `:700` `realSolReserves: 85 * 1e9` fabrikasi untuk token
  non-pump. Saat ini write-only/tidak memengaruhi gate (kelas M3), tapi ranjau
  darat bila field mulai dibaca.
- **O-20** — `stopAlgoScanner` (`algoScanner.ts:745-751`) tidak menunggu
  `runAlgoScanCycle` yang sedang in-flight → buy bisa fire saat shutdown setelah
  `stopMarketStreamer`. Tambahkan guard `isShuttingDown`.
- **O-21** — `AUTO_WHALE_DISCOVERY`, `COPY_SELL_ENABLED`, dan seluruh konfigurasi
  whale scout vestigial (tidak ada reader di luar `config.ts`) — hapus agar tidak
  membingungkan.
- **O-22** — `src/index.ts:99-106`: `process.exit(0)` langsung setelah
  `bot.stop()` (sinkron, mungkin belum selesai). Minor; beri jeda/await bila
  Telegraf stop async.

## Yang sudah benar (tidak perlu diubah)
- RBAC callback: `ADMIN_CALLBACK_PREFIXES` mencakup semua callback mutasi
  (`buy_quick_`, `cbuy_`, `sell_100_`, `confirm_sell_100_`, `cancel_*`,
  `reset_*`, `menu_settings`, `ws_remove_`); tombol buy/sell untuk watcher
  ditolak dengan benar.
- `/kick` tidak lagi mengklaim likuidasi palsu (F-01b); `sellingPositionIds`
  dilepas di `finally` (`tradeManager.ts:931-933`).
- DexScreener punya 429 circuit backoff + cache (`dexscreener.ts:123,228`).
- MarketStreamer punya WS reconnect backoff (`marketStreamer.ts:58-69,725`).
- Stop function membersihkan semua timer & WS subscription dengan benar.
- Secret di stack trace di-redact sebelum log (`index.ts:20-33`).
