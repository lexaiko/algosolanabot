# Exit & Risk Engine Audit Report

**Repo:** `~/workspace/bots/algosolanabot` (Node.js/TypeScript)
**Tanggal audit:** 29 Sep 2026
**Auditor:** subagent independen (read-only — tidak ada file yang diubah)
**Scope:** exit engine produksi (`src/services/tradeManager.ts` → `evaluatePosition` + `executeSellToken`), paper-fill simulator (`src/services/dexSimulator.ts`), akuntansi DB (`src/db/index.ts`), parameter (`src/config.ts`), mirror backtest (`src/execution/positionManager.ts`), callback Telegram (`src/bot/telegram.ts`).
**Di luar scope:** entry engine, scorer (diaudit agent terpisah).

## Ringkasan eksekutif

Exit engine secara struktural sudah benar arahnya (ratchet 100% single-exit, floor net-of-fees, double-sell guard, anti stale-price untuk non-emergency). **Tetapi ada 1 bug kritis dan 4 temuan major** yang langsung menyentuh P&L paper dan integritas exit:

1. **[CRITICAL]** Phantom-exit guard memblokir *manual sell* saat posisi rugi — user tidak bisa cut loss manual via tombol Telegram.
2. **[MAJOR]** Exit darurat (AUTO_SL / VELOCITY_DUMP / FLASH_EXIT) disimulasikan dengan slippage pasar tenang — parameter `isEmergencyDump` tidak pernah di-passing. Paper P&L untuk exit yang paling penting justru paling optimis.
3. **[MAJOR]** Circuit breaker 3-SL tidak menghitung VELOCITY_DUMP_RESCUE / FLASH_EXIT — hari berdarah via dump cepat tidak memicu halt.
4. **[MAJOR]** Kelly sizing diberi makan `pnl_pct` **gross** (belum dikurangi fee ~2.9% round-trip) — sizing bias optimis.
5. **[MAJOR]** Heat cap 50% & daily stop -8% memakai equity = kas + *notional entry* (bukan mark-to-market), dan daily stop hanya menghitung realized — lindungannya lebih longgar dari yang diklaim.

Detail tiap temuan di bawah, diurut dari dampak terbesar ke P&L.

---

## F-01 [CRITICAL] Phantom-exit guard memblokir manual sell saat rugi

**Lokasi:** `src/services/tradeManager.ts:727-730`, dipicu dari `src/bot/telegram.ts:1187` (`MANUAL_INLINE_BUTTON`) dan `src/bot/telegram.ts:294` (`MANUAL_KICK_EXIT (...)`).

**Kode:**
```ts
const isProfitTakingExit = !/SL|DUMP|FLASH|VELOCITY|ZOMBIE|MAX_HOLD/.test(reason);
if (isProfitTakingExit && effectiveExitPriceUsd <= pos.entry_price_usd) {
  return { success: false, message: 'Phantom exit blocked — effective exit price tidak di atas entry price.' };
}
```

**Masalah:** Guard ini dirancang untuk mencegah *phantom spike* DexScreener memicu ratchet exit palsu (tujuan valid). Tapi klasifikasinya memakai regex substring case-sensitive atas free-text `reason`. String `"MANUAL_INLINE_BUTTON"` dan `"MANUAL_KICK_EXIT (alasan)"` tidak mengandung satupun pola → diklasifikasikan sebagai "profit-taking exit" → **sell ditolak mentah-mentah setiap kali posisi sedang di bawah entry**.

Dampak konkret:
- User menekan "✅ Ya, Jual 100%" pada posisi -5% → balasan: `❌ Gagal mengeksekusi penjualan: Phantom exit blocked...`. **Perintah eksplisit user untuk cut loss ditolak bot.**
- `/kick <mint>` (telegram.ts:294) return value-nya bahkan diabaikan, lalu bot mengirim pesan `Posisi ... langsung dilikuidasi 100%!` — **pesan yang berbohong**: posisi tidak jadi dijual kalau sedang rugi.

**Dampak ke P&L:** Exit manual adalah last-resort control user. Ketika paling dibutuhkan (posisi rugi, user panik), ia tidak berfungsi.

**Saran perbaikan:**
1. Ganti klasifikasi regex dengan parameter eksplisit, mis. `executeSellToken(posId, sellPct, reason, { allowUnderwaterExit: boolean })` atau enum `ExitClass { PROFIT_TAKE, STOP, EMERGENCY, MANUAL, TIME_STOP }`.
2. `MANUAL_*` harus selalu `allowUnderwaterExit = true` — user yang minta, user yang tanggung.
3. Perbaiki `/kick`: cek `result.success` sebelum mengklaim likuidasi berhasil.

---

## F-02 [MAJOR] Exit darurat disimulasikan dengan slippage pasar tenang

**Lokasi:** `src/services/tradeManager.ts:710-717` (pemanggil), `src/services/dexSimulator.ts:72,86-96` (parameter yang tidak pernah dipakai).

**Masalah:** `simulateRealisticSell` punya parameter `isEmergencyDump` yang mengaktifkan jalur realistis untuk exit panik: slippage tolerance 8%+ (vs 2.5%), penalti adverse slippage 2–4.5%, dan latensi retry 1200–2000ms. **Tetapi `executeSellToken` memanggilnya hanya dengan 6 argumen — `isEmergencyDump` selalu default `false`.** Artinya AUTO_SL, VELOCITY_DUMP_RESCUE, dan FLASH_EXIT_RUG_BUSTER — tepat tiga exit yang terjadi saat likuiditas sedang menguap — disimulasikan seolah-olah pasar tenang.

**Dampak ke P&L:** Paper P&L untuk kategori exit yang paling merugikan justru paling optimis. Selisih 2–4.5% per emergency exit, dan 4 dari 5 trade terakhir keluar via AUTO_SL/VELOCITY_DUMP. Paper terlihat lebih baik dari realita secara sistematis.

**Saran perbaikan:** Teruskan flag dari reason:
```ts
const isEmergency = /VELOCITY_DUMP|AUTO_SL|FLASH_EXIT/.test(reason);
const simResult = await simulateRealisticSell(..., CONFIG.SLIPPAGE_PCT, isEmergency);
```
(Lebih baik lagi: gabungkan dengan F-01 — satu enum `ExitClass` yang mengendalikan phantom guard, emergency slippage, dan breaker counting sekaligus.)

---

## F-03 [MAJOR] Circuit breaker tidak menghitung dump-rescue / flash-exit

**Lokasi:** `src/db/index.ts:879-891` (`getDailyStopLossCount`), dipicu dari `src/services/tradeManager.ts` (~baris 900, blok circuit breaker di `executeSellToken`).

**Masalah:** Breaker menghitung `reason LIKE '%SL%' OR reason LIKE '%STOP_LOSS%'`. Yang lolos hitungan: `AUTO_SL`. Yang **tidak** terhitung: `VELOCITY_DUMP_RESCUE` (tidak mengandung "SL"), `FLASH_EXIT_RUG_BUSTER`, `WHALE_DUMP_FOLLOW`, `ZOMBIE_TIME_STOP`. Padahal velocity-dump rescue adalah kerugian yang *lebih* cepat dan *lebih* violent dari AUTO_SL biasa.

**Dampak ke P&L:** Skenario "5x VELOCITY_DUMP_RESCUE dalam sehari" — masing-masing -14% dalam 90 detik — tidak pernah memicu halt 3-SL. Kill-switch hanya menangkap kerugian yang lambat, bukan yang cepat. Dari 5 trade terakhir: 3 AUTO_SL terhitung, 1 VELOCITY_DUMP_RESCUE dan 1 ZOMBIE tidak.

**Saran perbaikan:** Hitung berdasarkan *kerugian*, bukan substring reason — mis. `reason` mengandung pola loss ATAU `netPnlSol < 0` dengan reason di daftar exit paksa. Paling bersih: pakai `ExitClass` yang sama dengan F-01/F-02; breaker menghitung setiap `STOP`/`EMERGENCY`/`TIME_STOP` yang net-nya negatif.

---

## F-04 [MAJOR] Kelly sizing diberi makan angka gross (belum dikurangi fee)

**Lokasi:** `src/db/index.ts:835-852` (`getEmpiricalKellyStats`), dipakai di `src/services/tradeManager.ts:105-135` (`getDynamicAlgoBuyAmount`).

**Masalah:** `getEmpiricalKellyStats` membaca `pnl_pct` dari tabel `positions` — yang dihitung sebagai `(exitPrice - entryPrice) / entryPrice`, **gross dari semua fee**. Round-trip fee riil ~2.5% DEX + network fee (~1.2% pada posisi 0.05 SOL) = **~2.9–3.7%** tidak tercermin di `winRate`/`payoff` yang masuk rumus Kelly.

**Dampak ke P&L:** Strategi dengan expectancy gross +1% terlihat positif bagi Kelly padahal net-nya −1.9%. Efeknya dibatasi oleh Bayesian prior (p=35%, b=3.0, bobot 20) dan clamp [2%, 8%], tapi arah biasnya tetap optimis — dan ini mengendalikan *ukuran setiap posisi*.

**Saran perbaikan:** Hitung Kelly dari `net_pnl_sol` di `trade_history` (per-position, net of fees), bukan `pnl_pct` gross. Atau terapkan haircut fee eksplisit pada payoff: `payoff_net = (avgWin - feePct) / (avgLoss + feePct)`.

---

## F-05 [MAJOR] Heat cap & daily stop memakai equity notional, bukan mark-to-market

**Lokasi:** `src/services/tradeManager.ts:264-290` (heat cap), `:292-330` (daily stop).

**Masalah:**
1. `equitySol = balance + Σ entry_sol` — deployed dihitung dari **notional entry**, bukan nilai pasar saat ini. Jika 5 posisi masing-masing −20% unrealized, equity overstated → heat cap 50% mengizinkan deployment lebih besar dari 50% *true* equity, dan ambang daily stop (−8% × equity) lebih longgar dari seharusnya.
2. Daily stop hanya membaca `getDailyRealizedPnl()` — **unrealized drawdown tidak dihitung**. Hari slow-bleed tanpa close tidak memicu stop; entry baru terus dibuka di atas book yang berdarah.

**Dampak ke P&L:** Kedua "rem institusional" lebih lemah dari klaimnya tepat saat paling dibutuhkan (selloff terkorelasi — yang diakui komentar kode sendiri berkorelasi ~0.7).

**Saran perbaikan:** Hitung `equitySol = balance + Σ (amount_tokens × current_price_usd / solPriceUsd)` (MTM, data sudah ada di `positions.current_price_usd`). Untuk daily stop, tambahkan komponen unrealized: `totalDrawdown = realized24h + Σ unrealizedPnl`; trip jika < −8% × equity MTM.

---

## F-06 [MAJOR] TIME_STOP 24 jam lumpuh oleh guard yang sama (latent)

**Lokasi:** `src/services/tradeManager.ts:1224` (`TIME_STOP (${hoursHeld}h Zombie Exit)`).

**Masalah:** Reason memakai "Zombie" huruf Z kapital → regex case-sensitive `/ZOMBIE/` tidak match → diklasifikasikan profit-taking → **reaper 24 jam tidak bisa menutup posisi yang sedang rugi**. Ini last-resort reaper; dalam praktik biasanya didahului `MAX_HOLD_TIMEOUT` 12 jam (baris 1167, match `/MAX_HOLD/` ✓), sehingga bug ini latent — tapi jika jalur 12 jam gagal sekali saja (exception swallowed di `evaluatePosition`, harga 0, dsb.), posisi zombie underwater tidak punya jalan keluar otomatis yang berfungsi.

**Saran perbaikan:** Sama seperti F-01 — ganti regex dengan klasifikasi eksplisit. Minimal: samakan casing (`ZOMBIE_EXIT`).

---

## F-07 [MINOR] Double-counting fee di akuntansi DB (arah konservatif)

**Lokasi:** `src/db/index.ts:771-774` (`closePosition`), `:906-927` (`getDailyRealizedPnl`).

**Masalah:** `simResult.netSol` (dexSimulator.ts:115-117) **sudah** dikurangi `dexFeeSol` + `networkFeeSol` sisi jual. Lalu `closePosition` menghitung `netPnlSol = (netSol − entry_sol) − CONFIG.ESTIMATED_SELL_FEE_SOL` — **sell network fee dikurangi dua kali** (~0.00025 SOL/trade). `getDailyRealizedPnl` mengulanginya di level agregat: `netPnlSol = Σ pnl_sol − totalFeesSol` padahal `pnl_sol` sudah net of sell-side fee.

**Dampak ke P&L:** Kecil (~0.00025 SOL/trade) dan arahnya konservatif (P&L tercatat sedikit lebih jelek dari realita; daily stop trip sedikit lebih awal). Tidak mengubah keputusan, tapi tiga buku (paper balance vs `trade_history.net_pnl_sol` vs `netPnlSol` versi tradeManager untuk Telegram/adaptiveLearning) tidak pernah rekonsiliasi — masing-masing memakai angka fee berbeda.

**Saran perbaikan:** Satu sumber kebenaran: `netPnlSol_position = (creditedSol + ataRefund) − (entrySol + actualBuyFeeSol + ATA_RENT)`. Hapus pengurangan fee kedua di `closePosition`; selaraskan `tradeManager` (yang memakai hardcoded `buyGasSol = 0.00008`, baris ~779) dengan fee aktual.

---

## F-08 [MINOR] Tiga angka buy-fee berbeda di tiga tempat

**Lokasi:** `src/services/tradeManager.ts:779` (`buyGasSol = 0.00008` hardcoded); `src/services/tradeManager.ts:~530` (`liveBuyFeeSol = simBuy.networkFeeSol`, yang benar-benar dipotong dari balance); `src/db/index.ts:637` (`buyFee = CONFIG.ESTIMATED_BUY_FEE_SOL` = 0.00035, yang dicatat di trade_history).

**Dampak:** `netPnlSol` yang dilaporkan ke Telegram / adaptiveLearningEngine / recordWhaleTrade memakai 0.00008 — ~4x lebih kecil dari estimasi config sendiri. Selisih absolut kecil, tapi ini P&L yang dilaporkan ke user dan ke adaptive learning.

**Saran:** Pakai satu nilai: fee aktual dari simulator (`simBuy.networkFeeSol`), simpan di kolom DB saat createPosition.

---

## F-09 [MINOR] Jurang (cliff) antar tier ratchet

**Lokasi:** `src/services/tradeManager.ts:1115-1140`.

**Masalah:** Tier diskrit 22/45/80/150 dengan floor `max(guaranteed, peak − trail) + fee`. Posisi peak +44.9% → **tanpa proteksi sama sekali** (bisa round-trip penuh ke −9.5% SL). Peak +45.0% → terkunci di +25%+fee ≈ +28.7%. Selisih 0.1% di peak mengubah hasil sebesar ~38%.

**Saran:** Floor kontinu, mis. `floor = max(3.5, min(peak − trail, tierGuarantee(peak))) + fee` dengan `tierGuarantee` linear antar breakpoint — atau turunkan tier pertama ke "setiap peak > X%, floor = max(3.5, peak − trail) + fee" tanpa tier.

---

## F-10 [MINOR] feeBufferPct hardcode fee DEX 2.5% untuk semua venue

**Lokasi:** `src/services/tradeManager.ts:95-104` (`estimateRoundTripFeePct`: `dexFeePct = 2 * 1.25`).

**Masalah:** Raydium fee riil 0.25%/side (dexSimulator.ts:64 membedakan: pump 1.25%, Raydium 0.25%), tapi buffer ratchet selalu memakai 2.5%. Untuk posisi Raydium, T1 floor ~2% terlalu tinggi → exit lebih dini dari seharusnya, menyerahkan upside.

**Saran:** `estimateRoundTripFeePct(entrySol, isPumpFun: boolean)` dengan `dexFeePct = isPumpFun ? 2.5 : 0.5`.

---

## F-11 [MINOR] Inkonsistensi max-hold: config 24 jam, kode 12 jam

**Lokasi:** `src/config.ts` (`MAX_HOLD_TIME_HOURS` default 24); `src/services/tradeManager.ts:1163-1168` (hardcode `12.0` di `evaluatePosition`); `:1221-1225` (heartbeat memakai config 24 jam).

**Masalah:** `MAX_HOLD_TIMEOUT` 12 jam selalu menang — knob config 24 jam tidak pernah tercapai, dan reaper 24 jam di heartbeat praktis dead code (selain bug F-06).

**Saran:** Satu sumber: `if (hoursHeld >= CONFIG.MAX_HOLD_TIME_HOURS)` di kedua jalur; hapus hardcode 12.0.

---

## F-12 [MINOR] Emergency bypass untuk stale-price guard

**Lokasi:** `src/services/tradeManager.ts:712-735`.

**Masalah:** Guard anti stale-price menolak sell saat `marketData` invalid — **kecuali** reason emergency (`FLASH_EXIT`/`VELOCITY_DUMP`/`AUTO_SL`), yang justru memakai `pos.current_price_usd` (harga terakhir yang diketahui, bisa stale). Keputusan trigger di `evaluatePosition` juga bisa berjalan di atas harga stale (`currentPrice` fallback ke `pos.current_price_usd` bila fetch gagal, baris ~1013-1035) — dan AUTO_SL adalah exit paling umum.

**Dampak:** Saat feed mati, paper mencatat exit pada harga yang belum tentu mencerminkan realita. Untuk paper: minor. Klaim komentar "Anti stale/fake price" hanya separuh benar.

**Saran:** Untuk emergency saat data invalid: catat `exitPriceUsd` dengan flag `stale=true` di journal/counterfactual, atau pakai harga bonding-curve on-chain sebagai fallback terakhir sebelum harga DB.

---

## F-13 [MINOR] `updatePaperBalance` clamp di nol menyembunyikan bug akuntansi

**Lokasi:** `src/db/index.ts:189-197` (`Math.max(0, current + amountDelta)`).

**Masalah:** Jika bug membuat deduksi melebihi saldo, hasilnya disamarkan menjadi 0 alih-alih surfaced sebagai negatif. Untuk paper wallet, negatif adalah sinyal bug yang berharga.

**Saran:** Log warning (atau Telegram alert) setiap kali clamp terpicu; pertimbangkan mengizinkan negatif di paper dengan flag.

---

## F-14 [MINOR] `target_tp_pct` / `getDynamicTpSl` dekoratif

**Lokasi:** `src/strategies/adaptiveLearningEngine.ts:122-132`; `src/services/tradeManager.ts:1115-1140`.

**Masalah:** `getDynamicTpSl` mengembalikan konstanta (TP 45, SL 9.5). `target_tp_pct` disimpan di DB tapi **tidak pernah dibaca** jalur exit — tier ratchet hardcode 22/45/80/150. Knob "adaptive TP" tidak adaptif dan tidak terpakai.

**Saran:** either hapus klaim "adaptive", atau benar-benar pakai `target_tp_pct` sebagai tier-2 ratchet.

---

## F-15 [INFO] Observasi tambahan (bukan bug)

- **Buy-side Jupiter path tanpa adverse-slip multiplier** (dexSimulator.ts, `simulateRealisticBuy`): sisi jual dapat penalti hingga 0.3%, sisi beli tidak ada. Optimisme kecil di entry (di luar scope exit, dicatat untuk auditor entry).
- **`halfClosePosition` dead**: diimpor tradeManager.ts:12 tapi tidak pernah dipanggil — seluruh exit sekarang 100%. Aman, tapi impor mati sebaiknya dibersihkan.
- **Flash-wick glitch filter** (tradeManager.ts:1041-1052) menolak tick >200% di pool tipis *tanpa* meng-update peak — desain benar (mencegah ratchet palsu), dengan tradeoff: moonshot genuine di pool <$15k tidak tercatat peak-nya.
- **Mirror backtest** (`src/execution/positionManager.ts`) sudah disinkronkan ke logika produksi (ratchet/fee/zombie sama) — diverifikasi konsisten, kecuali ia tidak mereplikasi phantom guard & Jupiter path (acceptable untuk backtest, tapi catat sebagai divergensi).
- **Double-sell guard** (`sellingPositionIds` + `evaluatingPositions` + re-validasi status di dalam lock, tradeManager.ts:646-700) — solid, urutan closePosition-sebelum-updatePaperBalance benar untuk mencegah double-credit.
- **ATA rent accounting**: dipotong saat buy (0.00203928), direfund hanya saat full close — benar.

---

## Verifikasi konsistensi (pertanyaan audit)

| Pertanyaan | Hasil |
|---|---|
| Apakah fee-aware floor benar-benar net of fees di semua tier? | Ya, arahnya benar (`+ feeBufferPct` di T1–T4, tradeManager.ts:1119-1137). Dengan catatan F-10 (overestimasi untuk Raydium). |
| Apakah zombie reaper memakai timestamp yang benar? | Ya — `pos.opened_at` dari DB (tradeManager.ts:1153-1155). |
| Apakah heat cap & daily stop memakai equity yang benar? | **Tidak** — pakai kas + notional entry, bukan MTM (F-05). |
| Apakah ada asumsi paper yang tidak realistis? | Ya — F-02 (emergency slippage tidak diterapkan), fill rate selalu 100% (tidak ada partial fill / tx gagal), buy-side tanpa adverse slip. |

## Rekomendasi prioritas

1. Perbaiki F-01 (manual sell diblokir) — ini bug integritas exit, bukan optimasi.
2. Terapkan F-02 (emergency slippage) — tanpa ini, semua statistik paper untuk exit darurat bias optimis dan Kelly (F-04) belajar dari angka yang salah.
3. Perbaiki F-03 + F-05 (breaker counting, MTM equity) — kill-switch harus menghitung kerugian yang benar.
4. Rapikan F-04, F-07, F-08 (satu buku P&L net yang rekonsiliasi) — fondasi untuk evaluasi PULLBACK_ABSORPTION yang jujur.
