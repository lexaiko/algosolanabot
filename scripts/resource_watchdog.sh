#!/bin/bash
# ==============================================================================
# Fail-Safe Resource Watchdog for Solana Trading Bot
# Designed for VPS with multi-tenant projects (lead_rank_crm, wa_rotator, mariadb)
# Automatically kills the bot if server RAM or CPU is near capacity.
# ==============================================================================

LOG_DIR="/home/semesta/tradingbot/logs"
LOG_FILE="$LOG_DIR/kill_switch.log"
mkdir -p "$LOG_DIR"

MIN_AVAIL_RAM_KB=150000    # 150 MB minimum available RAM
MAX_CPU_PERCENT=90         # 90% CPU usage threshold
HIGH_CPU_COUNT=0

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

echo "$(date '+%Y-%m-%d %H:%M:%S') [WATCHDOG] Resource watchdog active and guarding VPS." >> "$LOG_FILE"

while true; do
  # 1. Check Available System Memory
  AVAIL_KB=$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null)
  if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt "$MIN_AVAIL_RAM_KB" ]; then
    AVAIL_MB=$((AVAIL_KB / 1024))
    echo "$(date '+%Y-%m-%d %H:%M:%S') [CRITICAL RAM SPIKE] Sisa RAM kritis: ${AVAIL_MB}MB (< 150MB)! Mematikan bot seketika..." >> "$LOG_FILE"
    pm2 stop solana-tradingbot >> "$LOG_FILE" 2>&1
    sleep 60
    continue
  fi

  # 2. Check CPU Spikes
  CPU_IDLE=$(top -bn1 | grep -i "Cpu(s)" | awk -F',' '{for(i=1;i<=NF;i++) if($i ~ /id/) print $i}' | awk '{print int($1)}' 2>/dev/null)
  if [ -n "$CPU_IDLE" ]; then
    CPU_USAGE=$((100 - CPU_IDLE))
    if [ "$CPU_USAGE" -gt "$MAX_CPU_PERCENT" ]; then
      HIGH_CPU_COUNT=$((HIGH_CPU_COUNT + 1))
      if [ "$HIGH_CPU_COUNT" -ge 3 ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [CRITICAL CPU SPIKE] CPU lonjak tinggi sustained: ${CPU_USAGE}% (> ${MAX_CPU_PERCENT}%)! Mematikan bot seketika..." >> "$LOG_FILE"
        pm2 stop solana-tradingbot >> "$LOG_FILE" 2>&1
        HIGH_CPU_COUNT=0
        sleep 60
        continue
      fi
    else
      HIGH_CPU_COUNT=0
    fi
  fi

  sleep 10
done
