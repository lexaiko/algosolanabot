#!/bin/bash
# ==============================================================================
# Fail-Safe Resource Watchdog for Solana Trading Bots
# Designed for VPS with multi-tenant projects (lead_rank_crm, wa_rotator, mariadb)
# Automatically shuts down bots if server RAM is full (< 150MB available),
# and automatically revives them once RAM recovers (> 400MB available).
# ==============================================================================

LOG_DIR="/home/semesta/tradingbot/logs"
LOG_FILE="$LOG_DIR/kill_switch.log"
mkdir -p "$LOG_DIR"

MIN_AVAIL_RAM_KB=150000    # 150 MB minimum available RAM before emergency shutdown
SAFE_RECOVER_RAM_KB=400000 # 400 MB available RAM before auto-reviving bots
BOTS_STOPPED_BY_WATCHDOG=0
RECOVER_COUNT=0

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Load Telegram credentials for emergency notifications
ENV_FILE="/home/semesta/tradingbot/.env"
TELEGRAM_BOT_TOKEN=""
TELEGRAM_ADMIN_ID=""

load_env() {
  if [ -f "$ENV_FILE" ]; then
    TELEGRAM_BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d '=' -f2- | tr -d '\r\n"')
    TELEGRAM_ADMIN_ID=$(grep '^TELEGRAM_ADMIN_ID=' "$ENV_FILE" | cut -d '=' -f2- | tr -d '\r\n"')
  fi
}

send_telegram_alert() {
  local msg="$1"
  load_env
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_ID" ]; then
    curl -s -m 8 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_ADMIN_ID}" \
      -d "parse_mode=Markdown" \
      --data-urlencode "text=${msg}" > /dev/null 2>&1
  fi
}

echo "$(date '+%Y-%m-%d %H:%M:%S') [WATCHDOG] RAM Guard active and guarding VPS." >> "$LOG_FILE"

while true; do
  AVAIL_KB=$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null)
  
  if [ -n "$AVAIL_KB" ]; then
    AVAIL_MB=$((AVAIL_KB / 1024))
    
    # 1. EMERGENCY RAM SHUTDOWN (< 150 MB available)
    if [ "$AVAIL_KB" -lt "$MIN_AVAIL_RAM_KB" ]; then
      if [ "$BOTS_STOPPED_BY_WATCHDOG" -eq 0 ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [CRITICAL RAM] Sisa RAM kritis: ${AVAIL_MB}MB (< 150MB)! Mematikan bot otomatis..." >> "$LOG_FILE"
        
        # Notify Admin via Telegram
        ALERT_TEXT="🚨 *PERINGATAN DARURAT: RAM SERVER PENUH!* 🚨%0A%0A• Sisa RAM: *${AVAIL_MB} MB* (< 150 MB)%0A• Tindakan: *Auto-Shutdown* kedua bot trading (Follow Whale & Algo)%0A%0A_Sistem dimatikan sementara agar VPS tidak freeze/crash. Watchdog akan otomatis menyalakan bot kembali begitu RAM pulih._"
        send_telegram_alert "$ALERT_TEXT"
        
        # Stop both bots safely
        pm2 stop solana-tradingbot solana-algobot >> "$LOG_FILE" 2>&1
        BOTS_STOPPED_BY_WATCHDOG=1
        RECOVER_COUNT=0
      fi
      sleep 30
      continue
    fi

    # 2. AUTO-RECOVERY WHEN RAM IS HEALTHY AGAIN (> 400 MB available for 3 cycles)
    if [ "$BOTS_STOPPED_BY_WATCHDOG" -eq 1 ]; then
      if [ "$AVAIL_KB" -gt "$SAFE_RECOVER_RAM_KB" ]; then
        RECOVER_COUNT=$((RECOVER_COUNT + 1))
        if [ "$RECOVER_COUNT" -ge 3 ]; then
          echo "$(date '+%Y-%m-%d %H:%M:%S') [RAM RECOVERED] RAM kembali lega: ${AVAIL_MB}MB (> 400MB)! Menghidupkan kembali kedua bot..." >> "$LOG_FILE"
          
          # Start both bots
          pm2 start solana-tradingbot solana-algobot >> "$LOG_FILE" 2>&1
          BOTS_STOPPED_BY_WATCHDOG=0
          RECOVER_COUNT=0
          
          # Notify Admin via Telegram
          RECOVER_TEXT="✅ *RAM SERVER KEMBALI PULIH!* ✅%0A%0A• Sisa RAM: *${AVAIL_MB} MB* (Aman)%0A• Tindakan: Menghidupkan kembali *solana-tradingbot* & *solana-algobot*.%0A%0A_Kedua bot trading aktif kembali._"
          send_telegram_alert "$RECOVER_TEXT"
        fi
      else
        RECOVER_COUNT=0
      fi
    fi
  fi

  # Passive CPU logging (without killing bots)
  CPU_IDLE=$(top -bn1 | grep -i "Cpu(s)" | awk -F',' '{for(i=1;i<=NF;i++) if($i ~ /id/) print $i}' | awk '{print int($1)}' 2>/dev/null)
  if [ -n "$CPU_IDLE" ]; then
    CPU_USAGE=$((100 - CPU_IDLE))
    if [ "$CPU_USAGE" -ge 95 ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [HIGH CPU INFO] CPU tinggi: ${CPU_USAGE}%, Sisa RAM: ${AVAIL_MB}MB (Aman, bot tetap berjalan)." >> "$LOG_FILE"
    fi
  fi

  sleep 10
done
