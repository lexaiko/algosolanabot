import { FeatureVector, StrategySignal, EntryLifecycleState } from '../core/types';
import { TokenMarketData } from '../types/index';
import { OpportunityScorer, opportunityScorer } from './opportunityScorer';
import { adaptiveLearningEngine } from '../strategies/adaptiveLearningEngine';
import { tokenTape, tapeVolume5mNormalized, tapeReturnPerMinutePct } from '../market/tokenTape';
import { getSolPriceUsd } from '../services/dexscreener';
import { CONFIG } from '../config';
import { observeContinuation, CONTINUATION_CONFIRM_BARS } from './continuationTracker';

export interface EntryDecisionResult {
  shouldEnter: boolean;
  state: EntryLifecycleState;
  compositeScore: number;
  reason: string;
  explanation: string;
  invalidationReason?: string;
  /** Which entry model fired.
   * Two models since 2026-09-29:
   * - PULLBACK_ABSORPTION (dip + rebound). PARABOLIC_BREAKOUT was deleted after
   *   0/4 live paper trades — buying spike tops is structural exit-liquidity
   *   provision, not an edge.
   * - MOMENTUM_CONTINUATION (3x confirmed higher-high pushes with rising
   *   volume + dominant flow, half size). For runners whose pullback never
   *   comes; the top-tick guard routes 75+ hugging-the-top candidates here
   *   instead of parking them in pullback-watch forever. */
  entryMode?: 'PULLBACK_ABSORPTION' | 'MOMENTUM_CONTINUATION';
}

export class EntryEngine {
  private scorer: OpportunityScorer;

  constructor(scorer: OpportunityScorer = opportunityScorer) {
    this.scorer = scorer;
  }

  /**
   * Evaluates entry quality through progressive finite state machine verification,
   * dynamically driven by the Adaptive Learning Engine's hurdle rate.
   */
  public evaluateEntryTiming(features: FeatureVector, signals: StrategySignal[]): EntryDecisionResult {
    const scoreResult = this.scorer.scoreOpportunity(features, signals);
    const score = scoreResult.compositeScore;
    // QUANT-05: Regime-aware hurdle — demand stronger setups when the tape is hostile.
    // PANIC / HIGH_VOLATILITY regimes have fatter left tails; raising the bar avoids
    // catching knives while letting quality setups through in healthy regimes.
    let regimeHurdleBump = 0;
    if (features.regime === 'PANIC') regimeHurdleBump = 8;
    else if (features.regime === 'HIGH_VOLATILITY') regimeHurdleBump = 5;
    else if (features.regime === 'TRENDING_DOWN') regimeHurdleBump = 3;
    const dynamicMinScore = adaptiveLearningEngine.getMinEntryScore() + regimeHurdleBump;
    const watchingThreshold = Math.max(40, dynamicMinScore - 18);

    // STAGE 1: IMMEDIATE INVALIDATION GATES (Fail-Fast)
    // Invalidation 1: Parabolic overextension
    const maxReturnPct = CONFIG.MAX_5M_PRICE_CHANGE_PCT || 50.0;
    if (features.return5m > maxReturnPct) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Candle 5 menit overextended (+${features.return5m.toFixed(1)}% > ${maxReturnPct}%), setup di-invalidasi untuk mencegah pucuk trap`,
        explanation: scoreResult.explanation,
        invalidationReason: 'PARABOLIC_5M_OVEREXTENDED'
      };
    }

    // Invalidation 2: Order Flow Dominance (OFD) Check - Sells dominant or balanced churn (AICAT trap prevention).
    // C3 (2026-09-29): buySellRatio is UNDEFINED on zero-sell/unknown flow — in
    // that case dominance is judged by flowImbalance (honest), and unknown flow
    // (imbalance 0) fails closed here.
    const ratioDominant = features.buySellRatio === undefined
      ? features.flowImbalance >= 0.15
      : features.buySellRatio >= 1.35;
    if (!ratioDominant || features.flowImbalance < 0.15) {
      const ratioStr = features.buySellRatio === undefined ? 'unknown' : `${features.buySellRatio.toFixed(2)}x`;
      return {
        shouldEnter: false,
        state: 'WATCHING',
        compositeScore: score,
        reason: `Order flow belum dominan buy (Buy/Sell: ${ratioStr} < 1.35x, Imbalance: ${(features.flowImbalance * 100).toFixed(0)}%). Aksi saling banting terdeteksi`,
        explanation: scoreResult.explanation,
        invalidationReason: 'CHURN_FLOW_LACKS_BUY_DOMINANCE'
      };
    }

    // Invalidation 3: Falling Knife / Deep Dump Guard
    if (features.drawdownFromPeakPct > 8.0) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Penurunan dari puncak terlalu dalam (-${features.drawdownFromPeakPct.toFixed(1)}% > 8.0%), terdeteksi pisau jatuh / dump in progress`,
        explanation: scoreResult.explanation,
        invalidationReason: 'FALLING_KNIFE_DUMP_IN_PROGRESS'
      };
    }

    // Invalidation 3b: Upper Wick Rejection Guard (Pucuk Guard / Anti-Distribution)
    // Rejects entries when the candle shows a long upper wick (> 40% of body),
    // which signals dev/insider selling into strength (distribution phase).
    //
    // HONEST-DATA RULE: when no wick measurement exists (upperWickRatio undefined),
    // the guard is SKIPPED — never invented. The old fallback computed a fake
    // ratio from drawdown that hard-rejected every pullback deeper than 3%,
    // silently strangling the PULLBACK_ABSORPTION entry model.
    if (features.upperWickRatio !== undefined && features.upperWickRatio > 0.40) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Jarum atas candle terlalu panjang (Upper Wick ${(features.upperWickRatio * 100).toFixed(0)}% > 40% dari body). Dev/insider terdeteksi jualan di pucuk (Distribution Phase)`,
        explanation: scoreResult.explanation,
        invalidationReason: 'UPPER_WICK_DISTRIBUTION_REJECTION'
      };
    }

    // Invalidation 4: Top-Tick Pucuk Trap Guard
    // Never buy a token clinging to the top of its 5m candle (+8% with < 1.5%
    // drawdown) on a SINGLE observation. The old code exempted "genuine
    // parabolic breakouts" from this guard — that exemption was deleted
    // 2026-09-29 after 0/4 live paper trades proved it buys exit-liquidity
    // tops.
    //
    // MOMENTUM_CONTINUATION (2026-09-29): when the hurdle is already cleared
    // (score >= dynamicMinScore), the candidate is NOT parked in pullback-watch
    // forever — it is routed to the continuation tracker. Three confirmed
    // higher-high pushes (rising volume + dominant flow each) prove the rally
    // is real and fire a half-size entry. A breakdown > 4% kills the thesis.
    //
    // 2026-09-30 (supervisor): NEAR-MISS observation. In HIGH_VOL/PANIC the
    // regime-adjusted hurdle (80/83) parks strong 70-79 runners at the top
    // with NO second path — the old code only observed >= dynamicMinScore.
    // Now 70+ parked candidates are also observed. This is NOT a hurdle cut:
    // observation is cheap, ENTRY still demands the same 3 confirmed pushes
    // (volume + flow proof each) and fires at half size. Below-70 candidates
    // keep the old unconditional pullback-watch. The counterfactual tracker
    // validates whether continuation-from-70 earns its keep.
    //
    // GRADUATION LANE (2026-09-30): fresh Raydium graduates are observed
    // regardless of score. They rarely reach 70 on thin tape, but the
    // continuation proof (3 confirmed higher-high pushes, each with rising
    // volume + dominant flow) is tape-agnostic — it does not depend on the
    // Goldilocks composite at all. Research 2026-09-30 (n=68): median 94 min
    // to 2x, so the scan cycle can catch them; every 2x+ excursion dumped
    // >50% within 24h, so ENTRY still requires the full 3 confirmations and
    // fires at half size, with the ratchet trailing stop as the exit.
    const CONTINUATION_OBSERVE_MIN = 70;
    const isGraduateLane = features.isFreshGraduate === true;
    if (features.return5m > 8.0 && features.drawdownFromPeakPct < 1.5) {
      const priceUsd = features.priceUsd;
      if ((score >= CONTINUATION_OBSERVE_MIN || isGraduateLane) && priceUsd !== undefined && priceUsd > 0) {
        const cont = observeContinuation(
          features.tokenId,
          priceUsd,
          features.volumeAcceleration,
          features.buySellRatio,
          features.flowImbalance,
          score
        );
        if (cont.confirmed) {
          const entryMode = 'MOMENTUM_CONTINUATION' as const;
          return {
            shouldEnter: true,
            state: 'ENTRY',
            compositeScore: score,
            reason: `Setup terkonfirmasi [${entryMode}]: ${CONTINUATION_CONFIRM_BARS}x higher-high bervolume, skor ${score}/100, flow dominan — rally terbukti, entry setengah size`,
            explanation: scoreResult.explanation,
            entryMode
          };
        }
        const resetNote = cont.reset ? ' (thesis lama break >4% — tracking diulang dari awal)' : '';
        return {
          shouldEnter: false,
          state: 'SETUP_FORMING',
          compositeScore: score,
          reason: `Harga menempel di puncak candle (+${features.return5m.toFixed(1)}%). Continuation ${cont.confirmations}/${CONTINUATION_CONFIRM_BARS} — menunggu higher-high bervolume berikutnya${resetNote}`,
          explanation: scoreResult.explanation,
          invalidationReason: 'AWAITING_CONTINUATION_CONFIRMATION'
        };
      }
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Harga menempel di puncak candle (+${features.return5m.toFixed(1)}%). Menunggu pullback sehat (-2% s/d -6%) untuk konfirmasi absorpsi`,
        explanation: scoreResult.explanation,
        invalidationReason: 'TOP_TICK_FOMO_GUARD'
      };
    }

    // Invalidation 5: Absorption Rebound Verification - Never buy a weak rebound!
    // R4 (2026-09-29): the old bar (return1m > -0.5) let FLAT ticks through —
    // a flat tick is a pause, not a rebound confirmation. Now requires a
    // genuinely green tick (return1m > +0.3%) with real participation
    // (checked at STAGE 3.5 via volumeAcceleration).
    //
    // M2 (2026-09-29): return1m is now a PER-MINUTE rate (%/min), normalized by
    // the actual minutes between tape points — the old code compared a raw
    // ~10-minute scanner return against a per-minute bar, making R4 ~10x weaker
    // than designed. M12: the drawdown bar moved 2.0% -> 1.5%, closing the
    // [1.5%, 2%) gap that slipped past both this gate and the top-tick guard.
    // HONEST-DATA: return1m UNDEFINED (tape unmeasurable) FAILS CLOSED here —
    // an unconfirmed rebound is not a confirmed one.
    if (features.drawdownFromPeakPct >= 1.5 && (features.return1m === undefined || features.return1m <= 0.3)) {
      const tickStr = features.return1m === undefined ? 'unknown' : `${features.return1m.toFixed(2)}%/min`;
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Pullback sedang berlangsung (-${features.drawdownFromPeakPct.toFixed(1)}%), namun rebound per-menit belum hijau kuat (${tickStr} <= +0.30%/min). Dilarang menangkap pisau jatuh sebelum ada pantulan terkonfirmasi`,
        explanation: scoreResult.explanation,
        invalidationReason: 'AWAITING_GREEN_REBOUND_TICK'
      };
    }

    // Invalidation 6: Poor execution economics (estimated impact > 3.5%)
    if (features.estimatedPriceImpactPct > 3.5) {
      return {
        shouldEnter: false,
        state: 'INVALIDATED',
        compositeScore: score,
        reason: `Biaya slippage & impact pool terlalu tinggi (${features.estimatedPriceImpactPct.toFixed(1)}% > 3.5%), rasio payoff tidak ekonomis`,
        explanation: scoreResult.explanation,
        invalidationReason: 'EXCESSIVE_SLIPPAGE_IMPACT'
      };
    }

    // STAGE 2: WATCHING
    if (signals.length === 0 || score < watchingThreshold) {
      return {
        shouldEnter: false,
        state: 'WATCHING',
        compositeScore: score,
        reason: `Sinyal strategi belum terbentuk atau skor di bawah ambang batas dasar (${watchingThreshold})`,
        explanation: scoreResult.explanation
      };
    }

    // STAGE 3: SETUP_FORMING
    if (score < dynamicMinScore) {
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Setup terdeteksi (${signals.map(s => s.strategyName).join(', ')}), menunggu konfirmasi skor adaptif (Skor saat ini: ${score}/100, Butuh: >=${dynamicMinScore})`,
        explanation: scoreResult.explanation
      };
    }

    // STAGE 3.5: ABSORPTION CONFIRMATION (R1+R4, 2026-09-29)
    // A high score is not an entry. The rebound must show REAL absorption:
    // buy-dominant flow (not just above the 1.35 churn line), strengthening
    // imbalance, and real participation (not a dead tick). Failures wait here
    // as SETUP_FORMING — the setup may confirm on a later tick.
    //
    // HONEST-DATA NOTE: two R1 sub-conditions are NOT verifiable from
    // FeatureVector and are therefore NOT faked: delta-imbalance vs 5m ago
    // (no per-tick buy/sell history exists) and no-new-low intra-minute
    // (no sub-minute tape). volumeAcceleration >= 1.5 is the honest proxy
    // for "rebound tick volume >= 1.5x average" — real measured pace vs
    // baseline, consistent with the scanner's own strong-flow bar (1.4).
    // C3/C4 (2026-09-29): buySellRatio / volumeAcceleration are UNDEFINED when the
    // underlying flow or volume baseline is unmeasured — undefined fails closed.
    // Zero-sell dominance is judged by flowImbalance (honest, no invented ratio).
    let absorptionBlockReason: string | null = null;
    const absorptionRatioOk = features.buySellRatio === undefined
      ? features.flowImbalance >= 0.3
      : features.buySellRatio >= 1.5;
    if (!absorptionRatioOk) {
      const ratioStr = features.buySellRatio === undefined ? 'unknown' : `${features.buySellRatio.toFixed(2)}x`;
      absorptionBlockReason = `rasio buy/sell ${ratioStr} < 1.5x (absorpsi belum dominan)`;
    } else if (features.flowImbalance < 0.3) {
      absorptionBlockReason = `imbalance ${(features.flowImbalance * 100).toFixed(0)}% < 30% (agresi beli belum kuat)`;
    } else if (features.volumeAcceleration === undefined || features.volumeAcceleration < 1.5) {
      const volStr = features.volumeAcceleration === undefined ? 'unknown' : `${features.volumeAcceleration.toFixed(2)}x`;
      absorptionBlockReason = `akselerasi volume ${volStr} < 1.5x (tick sepi / baseline tak terukur, bukan absorpsi)`;
    }
    if (absorptionBlockReason) {
      return {
        shouldEnter: false,
        state: 'SETUP_FORMING',
        compositeScore: score,
        reason: `Skor lolos (${score}/100) tapi konfirmasi absorpsi belum terpenuhi: ${absorptionBlockReason}. Menunggu tick rebound yang valid`,
        explanation: scoreResult.explanation,
        invalidationReason: 'AWAITING_ABSORPTION_CONFIRMATION'
      };
    }

    // STAGE 4: CONFIRMED & ENTRY — single model: PULLBACK_ABSORPTION.
    const entryMode = 'PULLBACK_ABSORPTION' as const;
    return {
      shouldEnter: true,
      state: 'ENTRY',
      compositeScore: score,
      reason: `Setup terkonfirmasi [${entryMode}]: skor ${score}/100 didukung ${signals.length} strategi (${signals.map(s => s.strategyName).join(', ')})`,
      explanation: scoreResult.explanation,
      entryMode
    };
  }
}

export const entryEngine = new EntryEngine();

/**
 * M3 (2026-09-29): DECISION-FILL DECOUPLING FIX.
 *
 * The scan verdict can be 30-60s stale by the time executeBuyToken fills — the
 * verdict was computed on the scan-time snapshot, but the fill price is fresh.
 * A token that passed absorption 30s ago may be bought after its rebound
 * already failed. This rebuilds a COMPACT feature vector from the FRESH market
 * snapshot + the in-memory tape and re-runs the full entry engine (score,
 * gates, R1 absorption). executeBuyToken rejects when !shouldEnter.
 *
 * The signal rules below mirror scanMarketOnce's (same thresholds); they are
 * intentionally compact rather than shared — the scanner's vector carries
 * display-only fields this path doesn't need.
 */
export async function revalidateEntryOnFreshData(
  market: TokenMarketData,
  tokenMint: string
): Promise<EntryDecisionResult> {
  const tape = tokenTape.getFeatures(tokenMint);

  // Tape belum matang -> REJECT (INVALIDATED), bukan vector dengan drawdown 0
  // yang lolos. C1 deleted the scanner's synthetic-drawdown branch; this path
  // must not reintroduce it through the back door.
  if (!tape.hasTape || tape.points < 2) {
    return {
      shouldEnter: false,
      state: 'INVALIDATED',
      compositeScore: 0,
      reason: 'Tape observasi belum matang (< 2 titik) — setup tidak bisa dikonfirmasi pada data fresh (observasi dulu)',
      explanation: 'Re-validation membutuhkan tape nyata; tanpa itu tidak ada bukti rebound.',
      invalidationReason: 'IMMATURE_TAPE'
    };
  }

  const solPrice = await getSolPriceUsd().catch(() => 0);
  // No $180 literal (m2): an unknown SOL price makes our buy's USD size and
  // price impact unverifiable -> fail closed, not a guessed constant.
  if (!(solPrice > 0)) {
    return {
      shouldEnter: false,
      state: 'INVALIDATED',
      compositeScore: 0,
      reason: 'Harga SOL tak terukur — impact buy tak terverifikasi (tolak fail-closed)',
      explanation: 'Tanpa harga SOL, ukuran buy USD dan estimasi slippage tidak bisa dihitung.',
      invalidationReason: 'UNKNOWN_SOL_PRICE'
    };
  }

  // M1/M2-normalized tape features (null -> undefined -> downstream fail-closed).
  const returnPerMin = tapeReturnPerMinutePct(tape);
  const vol5m = tapeVolume5mNormalized(tape) ?? market.volume5m;
  const vol1h = market.volume1h;
  const volumeAcceleration =
    vol5m !== undefined && vol1h !== undefined && vol1h > 0
      ? Math.min(10, (vol5m * 12) / vol1h)
      : undefined;

  const txnsUnknown = market.txns5mBuys === undefined || market.txns5mSells === undefined;
  const buys = market.txns5mBuys ?? 0;
  const sells = market.txns5mSells ?? 0;
  const tradeCount = buys + sells;
  const buySellRatio: number | undefined = !txnsUnknown && sells > 0 ? buys / sells : undefined;
  const flowImbalance = tradeCount > 0 ? (buys - sells) / tradeCount : 0;

  const ret5m = market.priceChange5m ?? 0;
  const realizedVol = tape.realizedVolPct ?? Math.max(2.0, Math.abs(ret5m) * 1.25);

  // m15: no $80 invented trade size — unknown stays unknown.
  const avgTradeSizeUsd: number | undefined =
    tradeCount > 0 && vol5m !== undefined ? vol5m / tradeCount : undefined;
  const avgTradeSizeSol =
    avgTradeSizeUsd !== undefined && solPrice > 0 ? avgTradeSizeUsd / solPrice : undefined;
  const netBuyFlowSolEst =
    buySellRatio !== undefined && buySellRatio >= 1.5 && tradeCount >= 10 && avgTradeSizeSol !== undefined
      ? Math.round(Math.max(0, buys - sells) * avgTradeSizeSol * 10) / 10
      : undefined;
  const buyPressureScore =
    tradeCount >= 10
      ? buySellRatio !== undefined
        ? buySellRatio >= 1.8 ? 90 : buySellRatio >= 1.3 ? 75 : 45
        : flowImbalance >= 0.6 ? 90 : flowImbalance >= 0.3 ? 75 : 45
      : undefined;

  const signals: StrategySignal[] = [];
  const tokenSym = market.symbol || 'UNKNOWN';
  const nowIso = new Date().toISOString();
  const mkSignal = (name: string, confidence: number): StrategySignal => ({
    signalId: `fresh_${tokenMint.slice(0, 6)}_${Date.now()}_${name}`,
    tokenId: tokenMint,
    tokenSymbol: tokenSym,
    strategyName: name,
    strategyVersion: '1.0',
    direction: 'BUY',
    confidence,
    regime: 'TRENDING_UP',
    invalidationPriceUsd: market.priceUsd * 0.9,
    targetTpPct: 25,
    targetSlPct: 8,
    suggestedHoldingPeriodMinutes: 15,
    featureSnapshot: {},
    generatedAt: nowIso,
    sourceTag: 'dexscreener-5m',
  });
  if (volumeAcceleration !== undefined && volumeAcceleration >= 1.6 && ret5m >= 2.5) {
    signals.push(mkSignal('MOMENTUM', Math.min(1.0, volumeAcceleration / 3.0)));
  }
  const flowSignalStrength = buySellRatio !== undefined ? buySellRatio : flowImbalance >= 0.6 ? 2.0 : 0;
  if (flowSignalStrength >= 1.6 && tradeCount >= 8) {
    signals.push(mkSignal('FLOW_IMBALANCE', Math.min(1.0, flowSignalStrength / 3.0)));
  }
  if ((netBuyFlowSolEst ?? 0) >= 2.0) {
    signals.push(mkSignal('BUY_PRESSURE', 0.85));
  }

  const refBuyUsd = (CONFIG.DEFAULT_BUY_AMOUNT_SOL || 0.05) * solPrice;
  const vector: FeatureVector = {
    tokenId: tokenMint,
    timestampMs: Date.now(),
    timeframe: '5m',
    priceUsd: market.priceUsd,
    return1m: returnPerMin ?? undefined,
    return5m: ret5m,
    return15m: tape.return15mPct ?? undefined,
    realizedVol,
    atrPct: Math.max(3.0, realizedVol * 1.2),
    breakoutDistancePct: Math.max(0, ret5m - 2.0),
    drawdownFromPeakPct: tape.drawdownFromPeakPct,
    upperWickRatio: tape.upperWickRatio ?? undefined,
    volume5mUsd: vol5m,
    volumeAcceleration,
    buySellRatio,
    flowImbalance,
    tradeCount5m: Math.max(1, tradeCount),
    avgTradeSizeUsd,
    liquidityUsd: market.liquidityUsd,
    estimatedPriceImpactPct: market.liquidityUsd > 0
      ? Math.min(10, (refBuyUsd / (market.liquidityUsd * 0.5)) * 100)
      : 10,
    netBuyFlowSolEst,
    buyPressureScore,
    cabalClusterRiskScore: undefined,
    regime: realizedVol >= 10.0 ? 'HIGH_VOLATILITY' : ret5m > 3.0 ? 'TRENDING_UP' : ret5m < -5.0 ? 'PANIC' : 'RANGE',
    quality: 'VALID',
  };

  return entryEngine.evaluateEntryTiming(vector, signals);
}
