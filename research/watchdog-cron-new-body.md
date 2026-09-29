# PARENT ACTION REQUIRED: update cron `algosolanabot-watchdog` via cron.update
# (subagent cannot update a cron that delivers to a WhatsApp-connected chat).
# Copy the body below VERBATIM into cron.update body for id=algosolanabot-watchdog.
# Keep: schedule (interval 5m), enabled, mode task, owner, delivery as-is.

Watchdog untuk Solana algo trading bot milik Eko di `~/workspace/bots/algosolanabot`.

Tugas tiap run — SELURUH urutan cek → (bila perlu) start → verifikasi HARUS berjalan di dalam SATU `flock -n` tunggal (atomic). Jangan pernah pecah jadi langkah terpisah di luar lock: pemecahan itulah yang dulu memungkinkan dua run yang overlap double-start.

Jalankan SATU perintah shell ini (satu perintah utuh, jangan dipecah):

flock -n /tmp/algosolanabot-watchdog.lock bash -c '
cd ~/workspace/bots/algosolanabot || exit 2
HEALTH=bot.health
fresh() { [ -f "$HEALTH" ] && [ $(( $(date +%s) - $(stat -c %Y "$HEALTH") )) -lt 180 ]; }
alive() { pgrep -f "tsx src/inde[x].ts" >/dev/null; }
if alive && fresh; then echo ALIVE; exit 0; fi
sleep 30
if alive && fresh; then echo ALIVE; exit 0; fi
pkill -f "tsx src/inde[x].ts" 2>/dev/null
sleep 3
rm -f tradingbot.lock
setsid nohup npx tsx src/index.ts >> bot.log 2>&1 < /dev/null &
sleep 45
count=$(pgrep -c -f "tsx src/inde[x].ts" || true)
if [ "${count:-0}" -gt 1 ]; then
  pkill -f "tsx src/inde[x].ts" 2>/dev/null; sleep 3; rm -f tradingbot.lock
  setsid nohup npx tsx src/index.ts >> bot.log 2>&1 < /dev/null &
  sleep 45
  count=$(pgrep -c -f "tsx src/inde[x].ts" || true)
fi
if [ "${count:-0}" -eq 1 ] && fresh; then echo RESTARTED-OK; exit 0; fi
echo "RESTART-FAILED count=${count:-0}"; tail -5 bot.log
'

Tafsir output:
- `ALIVE` → bot hidup sehat (proses ada DAN heartbeat <3 mnt). Selesai, diam, tidak perlu lapor apa-apa.
- flock gagal mengambil lock (tidak ada output) → run lain sedang menangani; selesai, diam.
- `RESTARTED-OK` → bot sempat mati/zombie, sudah direstart, sekarang tepat 1 instance sehat. Lapor singkat ke user (Bahasa Indonesia): "Bot sempat mati/zombie, sudah direstart, sekarang hidup."
- `RESTART-FAILED ...` → lapor ke user (Bahasa Indonesia) bahwa restart gagal, sertakan 5 baris terakhir bot.log yang relevan.

Aturan keras:
- "Sehat" = proses ada DAN bot.health segar (<180 dtk). Proses ada tapi health basi = ZOMBIE → diperlakukan DEAD (dibunuh, direstart). Ini menutup lubang O-07: proses korup yang masih muncul di pgrep.
- Jangan start bot di luar urutan flock di atas, dengan alasan apapun.
- Jangan pernah biarkan >1 instance hidup: skrip membunuh duplikat bila pgrep -c > 1. Bot sendiri juga punya singleton guard (tradingbot.lock, PID file) — instance kedua exit(1) sendiri.
- Log selalu append (>>) agar riwayat tidak terhapus.
- Threshold heartbeat 180 detik mengikuti interval heartbeat bot (30 dtk di src/index.ts). Jangan ubah sepihak.
