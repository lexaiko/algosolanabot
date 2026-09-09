# Institutional-Grade Systematic Solana Trading System Architecture & Operational Manual

This manual documents the engineering specifications, domain models, operational runbook, security checklist, and deployment procedures for the institutional Solana quantitative trading system.

---

## 1. System Architecture & Component Decoupling

The platform is designed as an **event-driven modular monolith**. It eliminates coupling between data collection, strategy evaluation, risk governance, and blockchain transaction execution.

```text
src/
├── core/                         # Immutable domain models, event contracts, enum types
│   └── types.ts
├── storage/                      # Dual-persistence layer (PostgreSQL production + InMemory/SQLite testing)
│   ├── interfaces.ts
│   ├── inMemoryStorage.ts
│   └── index.ts
├── market/                       # Ingestion, deduplication, quality flags & candidate discovery
│   ├── marketDataEngine.ts
│   ├── safetyGate.ts             # Hard security gates vs soft penalties
│   ├── discoveryFunnel.ts        # Progressive multi-stage filtering
│   └── index.ts
├── features/                     # Real-time quantitative feature computation
│   ├── featureEngine.ts          # Price structure, volume acceleration, flow imbalance, liquidity
│   └── index.ts
├── strategies/                   # Regime classification & independent strategy modules
│   ├── interfaces.ts
│   ├── regimeEngine.ts           # TRENDING_UP, RANGE, HIGH_VOLATILITY, LOW_LIQUIDITY, PANIC
│   ├── momentumStrategy.ts       # Multi-horizon sustained momentum
│   ├── breakoutStrategy.ts       # Volume-backed structural breakout
│   ├── flowImbalanceStrategy.ts  # Persistent asymmetric buy-side pressure
│   ├── whaleConfirmationStrategy.ts # Qualified smart money accumulation (never naive copy)
│   ├── strategyEngine.ts
│   └── index.ts
├── execution/                    # Order state machines, opportunity scoring & position management
│   ├── opportunityScorer.ts      # Transparent, explainable scoring breakdown
│   ├── entryEngine.ts            # FSM: WATCHING -> SETUP_FORMING -> TRIGGERED -> ENTRY / INVALIDATED
│   ├── executionEngine.ts        # Order lifecycle: CREATED -> SIMULATED -> SIGNED -> SUBMITTED -> CONFIRMED
│   ├── positionManager.ts        # Stage 1 50% TP, Moonbag Trailing Stop, Hard SL, Time-decay reaper
│   └── index.ts
├── risk/                         # Supreme Veto Authority & Portfolio Governance
│   ├── riskEngine.ts             # Drawdown ceiling, consecutive losses circuit breaker, Fractional Kelly
│   └── index.ts
├── journal/                      # Decision recording, counterfactual analysis & statistical expectancy
│   ├── decisionJournal.ts        # Records 100% of candidates (Executed, Skipped, Vetoed)
│   ├── expectancyEngine.ts       # Win Rate, Payoff Ratio, Profit Factor, Expectancy in R, Alpha decay
│   └── index.ts
├── backtest/                     # Event-driven historical & synthetic tick replay
│   ├── eventBacktester.ts        # Identical interface driving Backtest, Paper, Shadow, and Live
│   └── index.ts
└── system/                       # Unified orchestrator facade
    ├── tradingSystem.ts
    └── index.ts
```

---

## 2. Production SQLite Database Schema (In-Process WAL)

Stored in `migrations/001_sqlite_schema.sql` and managed in `tradingbot.db`:
- `tokens`: Discovered token metadata.
- `pools`: AMM liquidity pools (Raydium, Pump.fun, Orca, Meteora).
- `market_events`: Normalized immutable stream of swaps, liquidity changes, and block prices with latency and data quality tags (`VALID`, `STALE`, `SUSPICIOUS`).
- `features_snapshot`: Rolling quantitative feature vectors computed at decision time.
- `decision_journal`: Every candidate observed, recording `decision` (`EXECUTED`, `SKIPPED`, `VETOED_SAFETY`, `VETOED_RISK`), full feature vector, and subsequent counterfactual returns (+15m, +1h, +4h).
- `orders`: Deterministic order lifecycle audit trail (`CREATED` ➔ `SIMULATED` ➔ `SIGNED` ➔ `SUBMITTED` ➔ `CONFIRMED` / `FAILED`).
- `positions`: Open/Closed portfolio positions, peak price watermarks, and granular close reasons.
- `strategy_versions`: Version-controlled parameters and walk-forward out-of-sample performance metrics.

---

## 3. Risk Engine Primacy & Capital Preservation Rules

1. **Supreme Veto Authority**:
   - The Risk Engine can veto any order proposed by any strategy or future ML model.
   - A signal score of 100/100 can **never** override a hard security or risk limit.
2. **Hard Veto Violations**:
   - Active Mint Authority or Freeze Authority.
   - LP not locked/burned on graduated AMM pools.
   - Cabal / Sybil wallet cluster detected via funder tracing.
   - Portfolio capacity full (`MAX_OPEN_POSITIONS`).
   - Insufficient SOL gas reserve (< 0.05 SOL).
   - Consecutive loss circuit breaker ($\ge 3$ consecutive stop-outs).
   - Correlated narrative sector exposure ($\ge 2$ tokens in the same narrative, e.g. AI or DOG).
   - Market regime in `PANIC`.
3. **Fractional Kelly Capital Allocation**:
   $$f^* = \text{Fraction} \times \frac{p \cdot b - q}{b}$$
   - Uses **Quarter-Kelly (0.25x)** for extreme resilience against non-ergodic volatility.
   - Win rate $p$ is dynamically dampened when consecutive losses occur.
   - Hard Liquidity Depth Cap: Allocation is strictly capped to $\le 1.5\%$ of pool liquidity to guarantee minimal price impact and clean liquidation.

---

## 4. Operational Runbook & Failure Handling

| Failure Scenario | Automated System Response | Operator Intervention |
| :--- | :--- | :--- |
| **RPC Degradation / Stale Feeds** | Data quality flagged `STALE` or `SUSPICIOUS`. Engine refuses to enter new trades ("Do Nothing" principle). | Check RPC provider status (`/status`). Switch fallback RPC if required. |
| **Transaction Submission Timeout** | Execution engine does not assume success. Polls block confirmations up to timeout slot; if unconfirmed, marks `FAILED` with idempotency guard to prevent duplicate fills. | Check SolScan for transaction signature. |
| **Consecutive Loss Spike** | Circuit breaker trips. Status set to defensive mode. Sizing throttled to 0 SOL. | Review trade journal (`/journal`), inspect recent regime shifts. Recalibrate only via out-of-sample backtesting. |
| **Emergency Market Crash** | Flash exit shield detects pool drain (>30%) or regime detects `PANIC` $\rightarrow$ Liquidates active open positions immediately. | Issue Telegram command `/emergency_stop` or `/pause`. |

---

## 5. Security Checklist

- [x] **No Hardcoded Private Keys**: Keypairs loaded exclusively from environment variables or secure key vaults.
- [x] **Zero Secret Logging**: Private keys and seed phrases are stripped from structured logger outputs.
- [x] **Telegram Admin Authorization**: Restricted by `TELEGRAM_ADMIN_ID`. Unauthorized users receive zero operational access.
- [x] **Idempotent Order Dispatch**: Every order intent has a unique UUID. Prevents double-spend during network retries.
- [x] **Jito Private Mempool Routing**: Prevents toxic sandwich attacks and frontrunning.
- [x] **Fail-Closed Design**: If database connection, RPC, or safety reports fail, the system defaults to **NOT TRADING**.
