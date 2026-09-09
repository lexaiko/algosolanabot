# 🤖 Solana Smart Money Tracker & Auto-Trading Bot

Bot trading otomatis di Telegram untuk ekosistem **Solana** dengan fitur pelacakan dompet *Smart Money / Paus*, audit keamanan *Anti-Rug* otomatis, dan eksekusi instan dengan *Auto Take-Profit & Trailing Stop-Loss*. 

Dilengkapi dengan **Mode Paper Trading (Akun Dummy $0 Risiko)** menggunakan saldo virtual 10 SOL dan harga pasar riil (DexScreener & Jupiter Quote).

---

## ⚡ Fitur Utama

- 🐋 **On-Chain Whale Tracker:** Memantau transaksi pembelian dompet pintar secara realtime melalui Solana RPC / Helius.
- 🛡️ **Anti-Rug & Honeypot Detector:** Audit otomatis sebelum membeli:
  - Validasi *Mint Authority* (wajib dinonaktifkan).
  - Validasi *Freeze Authority* (wajib dinonaktifkan).
  - Validasi *LP Burned / Locked*.
  - Evaluasi konsentrasi kepemilikan Top 10 Holders.
- 🧪 **Paper Trading Engine ($0 Risiko):** Menguji strategi secara langsung di pasar riil tanpa risiko uang nyata.
- 🎯 **Auto Take-Profit & Trailing Stop-Loss:**
  - Auto-Sell saat profit mencapai target (default: `+50%`).
  - Auto Cut-Loss jika harga anjlok (default: `-20%`).
  - Trailing Stop untuk mengunci profit saat harga berbalik arah dari titik puncak.
- 📱 **Antarmuka Telegram Interaktif:** Dashboard status, pemantau PnL realtime, tombol jual 1-klik, dan audit koin instan.

---

## 🚀 Cara Menjalankan

### 1. Konfigurasi Bot Telegram
Buka file `.env` dan masukkan token bot Telegram Anda:
```env
TELEGRAM_BOT_TOKEN=123456789:ABCDefgh-your-token-from-botfather
TELEGRAM_ADMIN_ID=7584736341
```
*(Token didapatkan secara gratis dari [@BotFather](https://t.me/BotFather) di Telegram).*

### 2. Jalankan Bot
Mode pengembangan (Hot-reload):
```bash
npm run dev
```

Mode produksi:
```bash
npm run build
npm start
```

---

## 📱 Daftar Perintah Telegram

| Perintah | Keterangan |
|---|---|
| `/start` atau `/status` | Menampilkan dashboard utama, saldo virtual, performa winrate, dan tombol navigasi. |
| `/whales` | Melihat daftar dompet paus yang sedang dipantau radar. |
| `/addwhale <address> <label>` | Mendaftarkan dompet paus baru ke radar. |
| `/delwhale <id>` | Menghapus dompet paus dari radar. |
| `/positions` | Melihat posisi trade yang sedang aktif dibuka beserta PnL realtime (+XX%). |
| `/history` | Melihat 10 transaksi terakhir yang sudah ditutup beserta laba/rugi bersih. |
| `/audit <token_mint>` | Melakukan audit keamanan instan koin apa saja (Mint, Freeze, LP, Top Holders). |
| `/buy <token_mint> [sol]` | Melakukan eksekusi pembelian sniper manual. |
| `/sell <position_id>` | Menjual posisi trade secara manual. |
| `/resetpaper` | Mereset saldo virtual Paper Trading kembali ke 10.0 SOL. |
| `/settings` | Melihat parameter risiko dan aturan bot. |

---

## 📁 Struktur Kode

```text
tradingbot/
├── src/
│   ├── bot/
│   │   └── telegram.ts         # Handler pesan & tombol interaktif Telegram
│   ├── db/
│   │   └── index.ts            # SQLite database (Whales, Positions, History, Wallet)
│   ├── services/
│   │   ├── antirug.ts          # Evaluasi keamanan token (RugCheck API & RPC)
│   │   ├── dexscreener.ts      # Data pasar realtime (Harga, MC, Likuiditas)
│   │   ├── jupiter.ts          # Jupiter swap quote & routing
│   │   ├── tracker.ts          # Engine pelacak transaksi dompet paus
│   │   └── tradeManager.ts     # Manajemen posisi, Auto-TP/SL & eksekusi beli/jual
│   ├── types/
│   │   └── index.ts            # Definisi tipe data TypeScript
│   ├── config.ts               # Pengaturan sistem & environment variables
│   ├── index.ts                # Master entry point bot
│   └── test_simulation.ts     # Script pengujian integrasi otomatis
├── .env                        # Konfigurasi privat
├── .env.example                # Template konfigurasi
├── package.json
└── tsconfig.json
```
