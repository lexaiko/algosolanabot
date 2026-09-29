/**
 * Autonomy kill-switch (O-10).
 *
 * When the bot starts without a valid TELEGRAM_ADMIN_ID there is zero human
 * oversight: no alerts, no /kick, no emergency cut-loss. Running autonomous
 * buys in that state is unacceptable, so index.ts disables autonomy
 * fail-closed and the entry pipeline must refuse autonomous buys while
 * this flag is off.
 *
 * Manual Telegram trading (admin-initiated buys/sells) is unaffected —
 * those go through explicit user confirmation, which IS oversight.
 *
 * Wiring contract (entry team): check `isAutonomousBuyEnabled()` at the
 * autonomous buy call sites (algoScanner runAlgoScanCycle, marketStreamer /
 * entryEngine WS buy path) and skip with a loud log when false.
 */

let autonomousBuyEnabled = true;
let disableReason = '';

export function isAutonomousBuyEnabled(): boolean {
  return autonomousBuyEnabled;
}

export function getAutonomyDisableReason(): string {
  return disableReason;
}

/** Called once at startup by index.ts. Not intended to be re-enabled at runtime. */
export function setAutonomousBuyEnabled(enabled: boolean, reason: string): void {
  autonomousBuyEnabled = enabled;
  disableReason = enabled ? '' : reason;
  if (!enabled) {
    console.error(`[Autonomy] 🛑 AUTONOMOUS BUY DISABLED (fail-closed): ${reason}`);
  }
}
