# Entry Edge Report — PULLBACK_ABSORPTION

**Tanggal:** 2026-09-29
**Peran:** Quant Researcher (read-only: tidak ada kode/DB yang diubah)
**Status model:** Satu-satunya model entry aktif. 0 sampel live. Scorer hand-tuned, belum di-fit ke data.

---

## 1. Ringkasan eksekutif

Analisis 446 baris `decision_journal` menemukan **mismatch struktural antara scorer dan model entry**:

- Bentuk pullback sejati (dd 2–8%, tick 1m tidak merah, 5m tidak vertikal, flow buy-dominant) hanya muncul **7 dari 446 keputusan (1,6%)**, dengan skor rata-rata **48,7** dan maksimum **64** — semuanya mati di STAGE 2/3, tidak ada yang pernah mencapai ENTRY.
- Rekonstruksi deterministik scorer menunjukkan pullback ideal hanya mencetak **~55/100**, di bawah watching threshold (57) dan jauh di bawah hurdle (75).
- Sebaliknya, skor ≥75 secara konstruksi **hanya bisa dicapai oleh pompa vertikal** (butuh return5m >20% + volume accel + flow imbalance tinggi secara bersamaan).
- Kelima trade tereksekusi semuanya punya `drawdownFromPeakPct` 0,0–0,5% — **dibeli tepat di tick puncak**, dan semuanya rugi. Ini konfirmasi kuantitatif diagnosis adverse selection.
- **Kesimpulan:** PULLBACK_ABSORPTION kelaparan bukan karena pasar "jarang kasih entry", tapi karena scorer tidak memberi poin pada bentuk pullback. Model ini tidak pernah diuji — ia tidak pernah diberi kesempatan jalan.

---

## 2. Temuan kuantitatif dari decision_journal (n=446)

### 2.1 Distribusi skor

| Band | n | % | Karakteristik rata-rata |
|---|---|---|---|
| 0–29 (junk) | 185 | 41,5% | ret5m +4,6%, ret1m −0,6%, buySellRatio 0,91 (sell-dominant), imbalance −0,16 |
| 30–57 (mid) | 174 | 39,0% | ret5m **+61,6%**, dd 1,9% — pompa ekstrem yang kena penalti overextension |
| 58–76 (near-miss) | 72 | 16,1% | ret5m +23,9%, **ret1m +8,5%**, bsr 6,46, imbalance 0,53 |
| 77+ (high) | 15 | 3,4% | ret5m +18,6%, **ret1m +16,4%**, dd 1,6% |

Hanya 5 dieksekusi (1,1%). Counterfactual: **0 dari 446 terisi** — tidak ada data outcome sama sekali.

### 2.2 Near-miss (58–76): bukan pullback yang gagal, tapi pompa yang ketahan

Hampir semua near-miss mati di STAGE 3 (`SETUP_FORMING`): *"menunggu konfirmasi skor adaptif (Butuh: >=75)"*. Profil rata-rata mereka — ret5m +24% dengan **tick 1m +8,5% hijau** — adalah **lanjutan pompa**, bukan pullback. Mereka bukan "pullback yang nyaris lolos"; mereka adalah kandidat momentum yang skornya kurang tinggi. Menurunkan hurdle untuk "meloloskan" mereka = meloloskan adverse-selection shape yang sama dengan 5 trade rugi kemarin.

### 2.3 Lima trade tereksekusi: dibeli di puncak absolut

| Token | Skor | ret5m | ret1m | dd dari peak | Hasil |
|---|---|---|---|---|---|
| baton | 75 | +6,4% | +1,0% | 0,0% | rugi |
| POUNCELOT | 82 | +13,4% | +28,0% | 0,0% | rugi |
| HOOKEDCAT | 84 | +10,6% | +1,0% | 0,5% | rugi |
| HOOKEDCAT | 88 | +28,0% | +1,0% | 0,5% | rugi |
| swordcat | 94 | +19,3% | +1,0% | 0,5% | rugi |

`drawdownFromPeakPct ≈ 0` di semua entry = entry di tick tertinggi candle. Skor 94-pun rugi. **Skor tinggi tidak memprediksi apa-apa selain "pompanya paling vertikal".**

### 2.4 Tujuh kandidat pullback sejati: semuanya mati sebelum ENTRY

| Token | Skor | Nasib |
|---|---|---|
| swordcat | 64 | STAGE 3 — kurang dari 75 |
| INUINK | 62 | STAGE 3 — kurang dari 75 |
| INUINK | 59 | STAGE 3 — kurang dari 75 |
| moin | 50 | STAGE 2 — di bawah watching threshold 57 |
| SNOWBALL | 42 | STAGE 2 |
| goon | 33 | STAGE 2 |
| BOB | 31 | STAGE 2 |

### 2.5 Rekonstruksi skor: pullback ideal = 55/100

Dihitung langsung dari `OpportunityScorer.scoreOpportunity` dengan `DEFAULT_WEIGHTS` (momentum 20, volume 20, flow 20, liquidity 20, buyPressure 15, consensus 10, volatility +8):

Kandidat pullback ideal: ret5m +6%, dd 4%, ret1m +0,5% (hijau), volAccel 1,5, imbalance 0,4, likuiditas $40k, buyPressure 70, 2 sinyal, regime TRENDING_UP:

- Momentum: round(6/35×20) = **3**
- Volume: round(0,5×20) = **10**
- Flow: round(0,4×20) = **8**
- Liquidity: **20**
- BuyPressure: round(10/40×15) = **4**
- Consensus: **10**
- Volatility: **0**
- **Total = 55** < 57 (watching) < 75 (hurdle)

Agar tembus 75, kandidat butuh kira-kira: ret5m ≥20% (momentum ≥11), volAccel ≥2,5 (volume ≥17), imbalance ≥0,6 (flow ≥12) — kombinasi yang di dunia nyata **hanya muncul bersamaan saat pompa vertikal dengan dd≈0**. Scorer memberi hadiah terbesar tepat pada shape yang dilarang model entry. Ini bukan miscalibration kecil; ini **inkompatibilitas desain**.

Catatan tambahan — "donut hole" momentum: `momentumScore = 0` bila ret5m >55%, penalti −20 bila >60%. Scorer paling murah hati pada pompa 20–55%: zona vertikal akhir, bukan base yang sehat.

---

## 3. Base rate eksternal (konteks, bukan bukti)

Angka-angka ini dari timing entry dan universe yang **berbeda** dari bot — dipakai untuk kalibrasi ekspektasi, bukan untuk klaim edge:

- **Graduation rate pump.fun → Raydium: 0,2–1,4%** (Dune Analytics, 2026). ~80% token mati dalam sehari; hanya 4,55% masih diperdagangkan setelah 90 hari (CoinGecko, 18,67 juta token).
- **Dataset 8.084 panggilan memecoin Solana** (smurfetc/solana-memecoin-calls-dataset, Jun–Sep 2026, median market cap saat call $12.299 — yaitu call *bonding curve*, timing entry terbaik yang mungkin): **35,7% mencapai 2x, 22,0% mencapai 3x, 11,6% mencapai 5x, 5,1% mencapai 10x; median peak hanya 1,59x; ~64% tidak pernah double.**
- Implikasi jujur: bahkan dengan timing entry paling awal, 2 dari 3 call tidak pernah 2x. Entry bot adalah *post-pump pullback* — seleksi yang secara struktural lebih buruk. Ekspektasi dasar (base rate) untuk "entry acak yang lolos filter longgar" adalah negatif. Filter harus *membuktikan* ia mengalahkan base rate ini, bukan berasumsi.
- Framing yang tepat untuk memecoin (maxxmonderoy/meme-coin): *"A memecoin has no cash flows and no fundamental value to be right about. The only questions that decide who gets paid are who holds what, and who is about to sell."* Edge — jika ada — hanya bisa datang dari membaca siapa yang jual dan apakah ada yang menyerapnya. Itulah inti aturan R1–R2 di bawah.

---

## 4. Aturan entry konkret & testable

Diurutkan berdasarkan ekspektasi nilai *prior* (plausibilitas mekanisme, bukan bukti — bukti belum ada). Setiap aturan punya **kriteria falsifikasi**: data apa yang membuktikan aturan ini salah. Semua diuji di paper trading; tidak ada yang diklaim profitable.

### R1. Konfirmasi absorpsi pada tick rebound (prior tertinggi)

**Mekanisme:** Literatur order-flow (footprint/delta) menempatkan *absorption* — volume besar tercetak pada satu level harga **tanpa** harga jebol melewatinya — sebagai salah satu sinyal reversal probabilitas tertinggi: limit bid besar sedang mempertahankan level. Ini menjawab pertanyaan "apakah pullback ini dibeli atau didistribusikan", yang tidak dijawab oleh tick hijau saja.

**Aturan:**
- Syarat dasar pullback tetap: dd 2–8%, tick 1m hijau.
- Tambahan (semua harus terpenuhi pada tick rebound):
  1. `buySellRatio ≥ 1,5` **dan** `flowImbalance` naik vs 5 menit sebelumnya (delta imbalance > 0 — agresi beli *menguat*, bukan sekadar positif).
  2. Volume tick rebound ≥ 1,5× rata-rata volume 10 tick terakhir (partisipasi nyata, bukan tick sepi).
  3. Harga tick rebound tidak mencetak low baru di bawah low pullback (level dipertahankan).
- Jika (1)–(3) tidak terpenuhi dalam 15 menit setelah pullback terbentuk → batal, jangan entry telat.

**Falsifikasi:** Dalam ≥30 paper trade forward, entry dengan konfirmasi absorpsi memiliki win rate ≤ entry pullback tanpa konfirmasi, atau expectancy (R-multiple) ≤ 0. Jika itu terjadi, absorpsi bukan edge di universe ini — buang aturannya.

### R2. Divergensi delta (bullish divergence)

**Mekanisme:** Divergensi bullish klasik — harga mencetak low baru, tetapi delta/volume beli relatif menguat (sellers losing force). Versi yang bisa dihitung dari fitur yang ada: bandingkan leg impuls vs leg pullback.

**Aturan:**
- Entry hanya jika: low pullback < low sebelumnya (≥1% lebih rendah) **dan** `flowImbalance` pada 5m pullback ≥ `flowImbalance` pada 5m impuls + 0,10 absolut.
- Tanpa divergensi → tidak entry, meski tick hijau.

**Falsifikasi:** ≥30 sampel per kelompok; jika entry divergen tidak mengungguli entry non-divergen pada 1h forward return atau R-multiple, aturan ini noise — buang.

### R3. Pullback band berbasis volatilitas (ganti band fixed 2–8%)

**Mekanisme:** Band fixed 2–8% salah di dua arah: di token low-vol, pullback 2% tidak pernah datang (model kelaparan); di token high-vol, 2% adalah noise dan 8% sudah termasuk pisau jatuh. Literatur retest-entry: pada nama parabolik, support realistis bisa −15–25%; "pullback" harus diskalakan ke volatilitas aset.

**Aturan:**
- Band pullback = [0,5 × ATR%, 2,0 × ATR%], di-clamp ke [1,5%, 12%].
- Guard pisau jatuh (`drawdownFromPeakPct > 8%`) diganti: invalidasi jika dd > 2,5 × ATR% (clamp maks 12%).
- ATR% memakai `atrPct` yang sudah ada di FeatureVector.

**Falsifikasi:** Bandingkan ≥30 entry band-volatilitas vs ≥30 entry band-fixed pada R-multiple; jika fixed menang atau seri tanpa perbedaan signifikan, kompleksitas ini tidak membayar — kembalikan ke fixed.

### R4. Kualitas tick rebound diperketat

**Mekanisme:** Syarat saat ini (`return1m > −0,5`) meloloskan tick datar — itu bukan konfirmasi rebound, itu jeda. Konfirmasi butuh gerakan hijau + partisipasi.

**Aturan:**
- `return1m > +0,3%` (bukan −0,5%), **dan** volume tick ≥ median volume 10 tick terakhir.
- Jika tick hijau tapi volume sepi → tetap `AWAITING_GREEN_REBOUND_TICK`, jangan entry.

**Falsifikasi:** Bandingkan forward return 15m antara entry dengan ret1m di (−0,5%, +0,3%] vs > +0,3%; jika tidak ada perbedaan, threshold ini kosmetik — buang.

### R5. Tangga pullback: bedakan dangkal vs dalam

**Mekanisme:** Pullback dalam di memecoin lebih sering berupa distribusi/dead-cat daripada diskon. Risiko harus dibayar dengan bukti lebih kuat.

**Aturan:**
- Pullback dangkal (dd 2–4% versi vol-scaled): boleh entry dengan konfirmasi standar (R4).
- Pullback dalam (dd 4–8% versi vol-scaled): **wajib** lolos konfirmasi absorpsi R1; jika tidak → skip total, bukan entry setengah.
- (Sizing ladder naik-turun diserahkan ke modul sizing; aturan ini hanya gate.)

**Falsifikasi:** Jika pullback dalam + absorpsi berkinerja ≥ pullback dangkal pada expectancy, diferensiasi ini tidak perlu — sederhanakan.

### R6. Konfirmasi second-leg (varian konservatif, opsional)

**Mekanisme:** Alih-alih menangkap pantulan pertama (yang paling sering dead-cat), tunggu harga merebut kembali level breakdown 1m / VWAP 1m — entry di leg kedua. Frekuensi turun, konfirmasi naik.

**Aturan:**
- Setelah pullback + tick hijau, entry hanya jika harga close kembali di atas level awal breakdown (harga sebelum pullback dimulai) dalam 30 menit.
- Jika tidak reclaim dalam 30 menit → setup kedaluwarsa.

**Falsifikasi:** Uji A/B vs entry pantulan pertama (R1): jika first-bounce expectancy ≥ second-leg expectancy pada ≥30 sampel masing-masing, R6 hanya membuang frekuensi — buang.

### R7. Time-box: momentum memecoin kedaluwarsa dalam hitungan menit

**Mekanisme:** Momentum memecoin meluruh dalam hitungan menit, bukan jam. "Pullback" dari puncak yang sudah berumur 2 jam adalah regime berbeda — biasanya distribusi lambat, bukan jeda sehat.

**Aturan:**
- Pullback hanya valid jika puncak (peak) terbentuk dalam **30 menit terakhir**. Puncak lebih tua → token masuk daftar pantau ulang, bukan entry.
- Butuh `timestampMs` peak; jika tidak tersedia → fail closed (skip).

**Falsifikasi:** Jika forward return tidak meluruh terhadap umur peak (uji korelasi pada ≥50 sampel), batas 30 menit arbitrer — longgarkan/buang.

### R8. Rebalancing scorer (perbaikan struktural, prioritas implementasi setelah R1–R4)

**Mekanisme:** Temuan §2.5 — scorer saat ini tidak *bisa* meloloskan pullback. Tanpa ini, R1–R7 tidak akan pernah mencapai ENTRY.

**Aturan:**
- Cap kontribusi momentum saat `drawdownFromPeakPct < 1,5` (jangan bayar mahal untuk momentum top-tick): `momentumScore = min(momentumScore, 6)` bila dd < 1,5%.
- Tambah **pullback-shape bonus** (maks +15): diberikan penuh bila dd dalam band (R3) **dan** ret1m > 0 **dan** flowImbalance > 0,3; skala linear bila sebagian.
- Hurdle 75 dipertahankan — yang diperbaiki adalah *apa yang diberi poin*, bukan ambang.

**Falsifikasi:** Butuh infrastruktur counterfactual diperbaiki dulu (saat ini 0/446). Setelah itu: kohort 75+ dari scorer baru harus mengungguli kohort 75+ scorer lama pada forward return 1h; jika tidak, rebalance ini hanya menggeser masalah — revert.

### Yang TIDAK boleh dilakukan

- **Jangan turunkan hurdle 75 → 60 "agar lebih sering entry".** Near-miss 58–76 adalah pompa lanjutan (ret1m +8,5%), bukan pullback. Meloloskan mereka = mengulang adverse selection dengan label berbeda.
- **Jangan entry pullback tanpa konfirmasi volume.** Tick hijau sepi = jeda, bukan absorpsi.
- **Jangan kejar pullback dalam (>8% / >2,5×ATR) sebagai "diskon lebih besar".** Itu pisau jatuh sampai terbukti sebaliknya.

---

## 5. Keterbatasan jujur

1. **Nol sampel live PULLBACK_ABSORPTION.** Semua di atas adalah hipotesis berprior, bukan edge yang terbukti. Tidak ada satu pun aturan di §4 yang boleh disebut profitable.
2. **Selection bias journal:** journal hanya berisi token yang ke-scan (trending/migrasi). Ini bukan universe acak; pola "pullback jarang" (§2.4) adalah pola *di dalam universe scanner*, bukan klaim tentang pasar memecoin keseluruhan.
3. **Tidak ada data outcome:** counterfactual 0/446 terisi. Analisis near-miss di §2.2 adalah analisis *mekanika funnel*, bukan profitabilitas. Kita tidak tahu apakah near-miss yang ditahan guard FOMO kemudian naik atau dump — dan tanpa data itu, kita tidak bisa mengklaim guard tersebut "benar", hanya bahwa ia konsisten dengan desain.
4. **Base rate eksternal tidak langsung transferable** (§3): dataset call bonding-curve ≠ entry post-pump. Dipakai untuk kalibrasi ekspektasi (prior negatif), bukan sebagai pembanding langsung.
5. **Fitur flow adalah estimasi agregat**, bukan wallet tracking (proyek ini tidak melacak wallet). R1–R2 memakai `buySellRatio`/`flowImbalance` dari agregat buy/sell — cukup untuk hipotesis, tidak setara dengan footprint sungguhan per price-level.
6. **Ukuran sampel minimum:** tidak ada kesimpulan kuantitatif sebelum ≥30 sampel per kelompok uji. Sampai saat itu, semua aturan berstatus "hipotesis aktif".

---

## 6. Urutan kerja yang disarankan

1. Perbaiki infrastruktur counterfactual (tanpa outcome data, §4 tidak bisa diuji) — ini prasyarat semua falsifikasi.
2. Implementasi R4 (termurah: dua threshold) + R1 (konfirmasi absorpsi) sebagai gate di `entryEngine`.
3. Implementasi R8 (rebalancing scorer) — tanpa ini R1/R4 tidak pernah mencapai ENTRY.
4. Kumpulkan ≥30 sampel, lalu uji R2/R3/R5/R6/R7 satu per satu secara A/B. Jangan implementasi semuanya sekaligus — kalau expectancy berubah, kita tidak tahu penyebabnya.

---

## Sumber

- Decision journal: `tradingbot.db` → `decision_journal` (446 baris, dibaca read-only 2026-09-29)
- Kode: `src/execution/entryEngine.ts`, `src/execution/opportunityScorer.ts`, `src/core/types.ts` (FeatureVector), `src/strategies/adaptiveLearningEngine.ts` (DEFAULT_WEIGHTS)
- Order-flow microstructure (absorption, delta divergence, stacked imbalances, CVD sebagai level bukan rate): pravindersamra/ctrader-bots — Order Flow System Stage1_OrderFlow_Research; daxalgo-terminal — order-flow.md; Hyblock Capital — Volume Delta/CVD documentation
- Retest-entry pitfalls (blow-off wick = exhaustion bukan entry; support parabolik −15–25%): himself65/trade-skills — 27-retest-entry-confirmation.md
- Base rate memecoin: Dune Analytics via Cointelegraph (graduation 0,2–1,4%); CoinGecko (18,67M token, 4,55% survive 90d); smurfetc/solana-memecoin-calls-dataset (8.084 call, 35,7% capai 2x, median peak 1,59x); maxxmonderoy/meme-coin CLAUDE.md (framing "who holds what, and who is about to sell")
