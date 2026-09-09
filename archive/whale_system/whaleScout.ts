import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { CONFIG } from '../config';
import { 
  addWhale, 
  removeWhale, 
  getAllWhales, 
  getActiveWhales, 
  getWhaleByAddress, 
  getWhalesForPruning,
  addToWhaleQueue,
  getWhaleQueue,
  promoteQueueWhaleToActive,
  isWhaleBlacklisted,
  blacklistWhale 
} from '../db/index';
import { refreshWhaleSubscriptions } from './tracker';
import { getTokenMarketData } from './dexscreener';
import { isCabalSuspect } from './cabalDetector';
import { connection } from './solanaConnection';

type TelegramNotifier = (message: string, extra?: any) => Promise<void>;
let scoutNotifier: TelegramNotifier | null = null;

export function setScoutNotifier(notifier: TelegramNotifier) {
  scoutNotifier = notifier;
}

async function notify(message: string, extra?: any) {
  if (scoutNotifier) {
    try {
      await scoutNotifier(message, extra);
    } catch (err: any) {
      console.error('[WhaleScout] Gagal mengirim notifikasi Telegram:', err.message);
    }
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// Filter out common system / AMM program addresses so they aren't recruited as whales
const SYSTEM_BLACKLIST = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'So11111111111111111111111111111111111111112',
]);

/**
 * Institutional Latency & MEV Disqualification:
 * Rejects high-frequency micro-flipping bots (holding time < 90s or excessive failure rate).
 */
export async function isMevBotSuspect(walletAddress: string, signatures: any[]): Promise<{ isMev: boolean; reason: string }> {
  if (!signatures || signatures.length < 5) {
    return { isMev: false, reason: 'Insufficient tx history to classify MEV' };
  }

  // 1. Failure rate check (Spam sniper bots often have > 65% failed txs)
  const failedCount = signatures.filter(s => s.err !== null).length;
  const failureRatePct = (failedCount / signatures.length) * 100;
  if (failureRatePct >= 65.0) {
    return { isMev: true, reason: `Tingkat kegagalan transaksi ${failureRatePct.toFixed(0)}% (Karakteristik spam sniper bot)` };
  }

  // 2. Inter-transaction spacing check (Sub-minute flipping)
  const blockTimes = signatures.map(s => s.blockTime).filter(bt => bt !== null && bt !== undefined) as number[];
  if (blockTimes.length >= 4) {
    let rapidIntervals = 0;
    for (let i = 0; i < blockTimes.length - 1; i++) {
      const diffSec = Math.abs(blockTimes[i] - blockTimes[i + 1]);
      if (diffSec < CONFIG.MIN_WHALE_HOLDING_SEC) {
        rapidIntervals++;
      }
    }
    // If more than 60% of recent txs happened within < 90s of each other
    if (rapidIntervals / (blockTimes.length - 1) >= 0.6) {
      return { isMev: true, reason: `Holding time ultra-pendek / transaksi beruntun (<${CONFIG.MIN_WHALE_HOLDING_SEC}s)` };
    }
  }

  return { isMev: false, reason: 'Human smart money profile' };
}

/**
 * Fetches top organic volume tokens from GeckoTerminal trending Solana pools,
 * with graceful fallback to DexScreener high-volume search.
 */
export async function getOrganicTrendingTokens(limit: number = 16): Promise<Array<{ tokenMint: string; poolName: string; volumeUsd: number }>> {
  const tokens: Array<{ tokenMint: string; poolName: string; volumeUsd: number }> = [];

  // Tier 1 & 2: GeckoTerminal Trending Pools (up to 16 top organic volume pools on Solana)
  try {
    const res = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools', {
      headers: { Accept: 'application/json' },
      timeout: 7000
    });

    const pools = res.data?.data;
    if (Array.isArray(pools)) {
      for (const p of pools) {
        if (tokens.length >= limit) break;
        const rawTokenId = p.relationships?.base_token?.data?.id || '';
        // Format: 'solana_<mint>'
        const tokenMint = rawTokenId.replace('solana_', '');
        const volumeUsd = parseFloat(p.attributes?.volume_usd?.h24 || '0');
        const reserveUsd = parseFloat(p.attributes?.reserve_in_usd || '0');
        const poolName = p.attributes?.name || 'Trending Pool';

        // Quality check: min $10k pool liquidity and min $50k 24h volume
        if (
          tokenMint && 
          tokenMint.length >= 32 && 
          reserveUsd >= 10000 && 
          volumeUsd >= 50000 &&
          tokenMint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' && // USDC
          tokenMint !== 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'    // USDT
        ) {
          if (!tokens.some(t => t.tokenMint === tokenMint)) {
            tokens.push({ tokenMint, poolName, volumeUsd });
          }
        }
      }
    }
  } catch (err: any) {
    console.warn('[WhaleScout] Gagal ambil GeckoTerminal trending pools:', err.message);
  }

  // Tier 3: Complement with DexScreener Fresh Active Solana Pairs
  if (tokens.length < limit) {
    try {
      const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 6000 });
      const pairs = res.data?.pairs?.filter((p: any) => 
        p.chainId === 'solana' && 
        (p.volume?.h24 || 0) >= 100000 && 
        (p.liquidity?.usd || 0) >= 15000
      ) || [];
      for (const p of pairs) {
        if (tokens.length >= limit) break;
        const tokenMint = p.baseToken?.address;
        if (tokenMint && !tokens.some(t => t.tokenMint === tokenMint)) {
          tokens.push({
            tokenMint,
            poolName: `${p.baseToken?.symbol || 'SOL'} / ${p.quoteToken?.symbol || 'SOL'}`,
            volumeUsd: p.volume?.h24 || 0
          });
        }
      }
    } catch {}
  }

  return tokens;
}

export interface ScoutOutcome {
  recruited: number;
  queued: number;
  isFull: boolean;
  totalWhales: number;
  maxWhales: number;
  queueLength: number;
}

/**
 * Auto-Scan & Recruit Smart Money Whales from Organic High-Volume Solana Pools (Pro-Grade)
 */
export async function scoutTrendingWhales(limitToRecruit: number = CONFIG.WHALE_SCOUT_BATCH_SIZE || 4): Promise<ScoutOutcome> {
  console.log('[WhaleScout] 🔍 Memulai pemindaian institusional pasar Solana (Organic High-Volume Pools)...');
  
  const currentWhales = getAllWhales();
  const currentQueue = getWhaleQueue();
  const isRosterFull = currentWhales.length >= CONFIG.MAX_ACTIVE_WHALES;

  if (isRosterFull && currentQueue.length >= 50) {
    console.log(`[WhaleScout] ℹ️ Radar paus (${currentWhales.length}/${CONFIG.MAX_ACTIVE_WHALES}) dan bangku cadangan (${currentQueue.length}/50) sudah penuh.`);
    return {
      recruited: 0,
      queued: 0,
      isFull: true,
      totalWhales: currentWhales.length,
      maxWhales: CONFIG.MAX_ACTIVE_WHALES,
      queueLength: currentQueue.length
    };
  }

  let recruitedCount = 0;
  let queuedCount = 0;

  try {
    // 1. Fetch Top Organic Volume Pools on Solana (GeckoTerminal $5M-$50M + DexScreener High-Volume)
    const targetTokens = await getOrganicTrendingTokens(16);
    if (targetTokens.length === 0) {
      console.log('[WhaleScout] ⚠️ Tidak ada token organik dengan likuiditas memadai ditemukan saat ini.');
      return {
        recruited: 0,
        queued: 0,
        isFull: isRosterFull,
        totalWhales: currentWhales.length,
        maxWhales: CONFIG.MAX_ACTIVE_WHALES,
        queueLength: currentQueue.length
      };
    }

    for (const tokenItem of targetTokens) {
      if ((recruitedCount + queuedCount) >= limitToRecruit) {
        break;
      }

      const tokenMint = tokenItem.tokenMint;
      console.log(`[WhaleScout] 🔎 Menganalisis pool: ${tokenItem.poolName} ($${(tokenItem.volumeUsd / 1_000_000).toFixed(2)}M 24h Vol) CA: \`${tokenMint}\`...`);
      const market = await getTokenMarketData(tokenMint);
      const symbol = market ? market.symbol : 'TOKEN';

      // 2. Query recent on-chain signatures for this token (Depth: 25 signatures)
      let sigs: any[] = [];
      try {
        sigs = await connection.getSignaturesForAddress(new PublicKey(tokenMint), { limit: 25 });
      } catch (err: any) {
        console.warn(`[WhaleScout] Gagal ambil signatures untuk ${tokenMint}:`, err.message);
        continue;
      }

      for (const sigInfo of sigs) {
        if (sigInfo.err) continue;
        if ((recruitedCount + queuedCount) >= limitToRecruit) break;

        await sleep(80); // Fast pacing enabled by Helius Round-Robin pool

        try {
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0
          });
          if (!tx || !tx.meta) continue;

          // Find the primary fee payer / user signer
          const firstAccount = tx.transaction.message.accountKeys[0];
          const feePayerKey = firstAccount?.pubkey ? firstAccount.pubkey.toBase58() : null;

          if (!feePayerKey || SYSTEM_BLACKLIST.has(feePayerKey) || isWhaleBlacklisted(feePayerKey)) continue;

          // Check if wallet is already registered in active roster
          if (getWhaleByAddress(feePayerKey)) continue;

          // Check if this wallet actually bought tokens in this tx
          const post = tx.meta.postTokenBalances?.find(b => b.owner === feePayerKey && b.mint === tokenMint);
          const pre = tx.meta.preTokenBalances?.find(b => b.owner === feePayerKey && b.mint === tokenMint);
          const postAmt = parseFloat(post?.uiTokenAmount?.uiAmountString || '0');
          const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmountString || '0');

          if (postAmt > preAmt) {
            // 1. Check buyer's native SOL balance (Pro criteria: >= 1.5 SOL)
            const balanceLamports = await connection.getBalance(new PublicKey(feePayerKey));
            const balanceSol = balanceLamports / 1_000_000_000;

            if (balanceSol < CONFIG.MIN_WHALE_BALANCE_SOL) {
              continue;
            }

            // 2. Check buy size: minimum 0.2 SOL spent
            const preSol = tx.meta.preBalances[0] || 0;
            const postSol = tx.meta.postBalances[0] || 0;
            const solSpent = (preSol - postSol) / 1_000_000_000;
            if (solSpent < CONFIG.MIN_WHALE_BUY_SOL) {
              continue;
            }

            // 3. Anti-Burner / Wallet History Audit (>= 10 txs)
            const pastSigs = await connection.getSignaturesForAddress(new PublicKey(feePayerKey), { limit: 20 });
            if (pastSigs.length < CONFIG.MIN_WHALE_HISTORY_TXS) {
              console.log(`[WhaleScout] ⏩ Abaikan ${feePayerKey.slice(0, 8)}: Dompet terlalu baru/burner (${pastSigs.length} txs).`);
              continue;
            }

            // 4. MEV Sniper & Latency Disqualification
            const mevCheck = await isMevBotSuspect(feePayerKey, pastSigs);
            if (mevCheck.isMev) {
              console.log(`[WhaleScout] 🤖 DITOLAK MEV/SNIPER: ${feePayerKey.slice(0, 8)} - ${mevCheck.reason}`);
              if (CONFIG.NOTIFY_ON_REJECT) {
                await notify(
                  `⚠️ *SCOUT AUDIT: DOMPET DITOLAK (MEV / HFT BOT)*\n\n` +
                  `📝 *Alamat:* \`${feePayerKey}\`\n` +
                  `🪙 *Kolam Acuan:* *${symbol}* (${tokenItem.poolName})\n` +
                  `🚫 *Alasan:* ${mevCheck.reason}\n\n` +
                  `_Bot menolak dompet ini demi menjaga portofolio dari jebakan micro-flipping bot._`
                );
              }
              continue;
            }

            // 5. Cabal / Sybil Cluster Shield: Verify funding source isn't linked to existing whales
            const cabalCheck = await isCabalSuspect(feePayerKey, getAllWhales());
            if (cabalCheck.isCabal) {
              console.log(`[WhaleScout] 🚨 DITOLAK CABAL/SYBIL: ${feePayerKey.slice(0, 8)} berbagi penyetor dana yang sama dengan ${cabalCheck.matchingWhales.join(', ')}`);
              if (CONFIG.NOTIFY_ON_REJECT) {
                await notify(
                  `🚨 *SCOUT AUDIT: DOMPET DITOLAK (CABAL / SYBIL CLUSTER)*\n\n` +
                  `📝 *Alamat:* \`${feePayerKey}\`\n` +
                  `🪙 *Kolam Acuan:* *${symbol}*\n` +
                  `🚫 *Alasan:* Terdeteksi berbagi penyetor dana on-chain dengan dompet radar: *${cabalCheck.matchingWhales.join(', ')}*\n\n` +
                  `_Bot menolak dompet ini untuk mencegah risiko dump bersama kelompok cabal._`
                );
              }
              continue;
            }

            // 6. Archetype Classification & Tier Sizing
            // All scouted candidates start strictly in PROBATION (Incubation Mode) until proven profitable
            let archetype = '🔬 PROBATION_SCOUT';
            let label = `🔬 Scout: $${symbol} Smart Buyer`;
            const tier: 'PROBATION' = 'PROBATION';

            if (balanceSol >= CONFIG.VIP_WHALE_BALANCE_SOL) {
              archetype = '👑 VIP_ACCUMULATOR_CANDIDATE';
              label = `👑 Paus: $${symbol} VIP Accumulator`;
            } else if (market && market.priceChange24h && market.priceChange24h > 100) {
              archetype = '🐋 EARLY_ACCUMULATOR';
              label = `🐋 Paus: $${symbol} Early Accumulator`;
            } else if (market && market.priceChange5m && Math.abs(market.priceChange5m) > 4) {
              archetype = '⚡ MOMENTUM_SWING';
              label = `⚡ Smart: $${symbol} Momentum Whale`;
            } else {
              archetype = '🎯 RAYDIUM_HUNTER';
              label = `🎯 Scout: $${symbol} Smart Buyer`;
            }

            // Check if active roster has open slots
            if (getAllWhales().length < CONFIG.MAX_ACTIVE_WHALES) {
              // Enrolled into active roster strictly in PROBATION mode (autoCopy = 0, zero capital risk)
              const added = addWhale(feePayerKey, label, CONFIG.DEFAULT_BUY_AMOUNT_SOL, 0, 'PROBATION');
              
              if (added) {
                recruitedCount++;
                console.log(`[WhaleScout] ✅ KANDIDAT LOLOS AUDIT PRO (${archetype}): ${label} (${feePayerKey}) Saldo: ${balanceSol.toFixed(2)} SOL | Txs: ${pastSigs.length}`);

                const recruitMsg = `🏛️ *KANDIDAT SMART MONEY LOLOS AUDIT INSTITUSIONAL (PRO)*\n\n` +
                  `🏷️ *Label:* ${label}\n` +
                  `📝 *Alamat:* \`${feePayerKey}\`\n` +
                  `🏆 *Arketipe:* *${archetype}*\n` +
                  `💰 *Saldo On-Chain:* *${balanceSol.toFixed(2)} SOL* (✅ Standar Pro >= ${CONFIG.MIN_WHALE_BALANCE_SOL} SOL)\n` +
                  `📜 *Riwayat Transaksi:* *${pastSigs.length}+ Transaksi* (✅ Bukan Burner Wallet)\n` +
                  `⚡ *Pemeriksaan MEV:* ✅ *LOLOS* (Bukan HFT Bot Micro-Flip)\n` +
                  `🛡️ *Pemeriksaan Cabal:* ✅ *LOLOS* (Funder Mandiri)\n` +
                  `🪙 *Kolam Acuan:* *${symbol}* (${tokenItem.poolName} - Vol 24j: *$${(tokenItem.volumeUsd / 1_000_000).toFixed(2)}M*)\n` +
                  `🛡️ *Status Copy:* *OFF (Masa Percobaan / Shadow Tracking)*\n\n` +
                  `_💡 Bot mengobservasi performa trader ini secara otomatis. Begitu terbukti mencetak trade profit nyata, bot akan otomatis mempromosikannya ke VERIFIED AUTO-COPY!_`;

                await notify(recruitMsg);
                break; // Diversify tokens
              }
            } else {
              // Active slots full -> Route into Shadow Queue (Bench Pipeline)
              const queued = addToWhaleQueue({
                address: feePayerKey,
                label,
                archetype,
                balanceSol,
                referenceToken: tokenMint,
                referencePool: tokenItem.poolName,
                score: balanceSol
              });

              if (queued) {
                queuedCount++;
                console.log(`[WhaleScout] 📋 MASUK SHADOW QUEUE (${archetype}): ${label} (${feePayerKey}) Saldo: ${balanceSol.toFixed(2)} SOL`);

                const queueMsg = `📋 *KANDIDAT SMART MONEY MASUK SHADOW QUEUE (BANGKU CADANGAN)*\n\n` +
                  `Slot radar aktif saat ini penuh (*${getAllWhales().length}/${CONFIG.MAX_ACTIVE_WHALES}*). Kandidat berkualitas ini disimpan di antrean cadangan:\n\n` +
                  `🏷️ *Label:* ${label}\n` +
                  `📝 *Alamat:* \`${feePayerKey}\`\n` +
                  `🏆 *Arketipe:* *${archetype}*\n` +
                  `💰 *Saldo On-Chain:* *${balanceSol.toFixed(2)} SOL* (✅ Standar Pro >= ${CONFIG.MIN_WHALE_BALANCE_SOL} SOL)\n` +
                  `📜 *Riwayat Transaksi:* *${pastSigs.length}+ Transaksi* (✅ Bukan Burner Wallet)\n` +
                  `⚡ *Pemeriksaan MEV:* ✅ *LOLOS* (Bukan HFT Bot Micro-Flip)\n` +
                  `🛡️ *Pemeriksaan Cabal:* ✅ *LOLOS* (Funder Mandiri)\n` +
                  `🪙 *Kolam Acuan:* *${symbol}* (${tokenItem.poolName} - Vol 24j: *$${(tokenItem.volumeUsd / 1_000_000).toFixed(2)}M*)\n\n` +
                  `_💡 Begitu ada paus aktif yang di-prune atau dieliminasi, sistem Auto-Substitution akan langsung mempromosikan kandidat teratas dari antrean ini ke radar aktif!_`;

                await notify(queueMsg);
                break; // Diversify tokens
              }
            }
          }
        } catch {
          // Ignore individual tx parse failure
        }
      }
    }

    if (recruitedCount > 0) {
      refreshWhaleSubscriptions();
      console.log(`[WhaleScout] 🎯 Berhasil merekrut ${recruitedCount} kandidat smart money berstandar pro ke radar aktif.`);
    }
    if (queuedCount > 0) {
      console.log(`[WhaleScout] 📋 Berhasil menambahkan ${queuedCount} kandidat smart money ke shadow queue (bangku cadangan).`);
    }
  } catch (err: any) {
    console.error('[WhaleScout] Error during scoutTrendingWhales:', err.message);
  }

  const latestWhales = getAllWhales();
  const latestQueue = getWhaleQueue();

  return {
    recruited: recruitedCount,
    queued: queuedCount,
    isFull: latestWhales.length >= CONFIG.MAX_ACTIVE_WHALES,
    totalWhales: latestWhales.length,
    maxWhales: CONFIG.MAX_ACTIVE_WHALES,
    queueLength: latestQueue.length
  };
}

/**
 * Auto-Prune Underperforming or Inactive Whales
 */
export async function pruneUnderperformingWhales(): Promise<number> {
  console.log('[WhalePruner] 🧹 Memeriksa dompet paus untuk evaluasi performa...');
  
  const allWhales = getAllWhales();
  // Keep at least 3 whales as safety floor
  if (allWhales.length <= 3) {
    return 0;
  }

  // 1. Institutional Rolling Alpha Decay: Check if active whales lost their edge in the last 7 days
  for (const whale of allWhales) {
    if (whale.tier !== 'PROBATION' && whale.auto_copy) {
      const { getWhaleRollingStats, demoteWhale } = await import('../db/index');
      const rolling = getWhaleRollingStats(whale.label, CONFIG.ROLLING_WINDOW_DAYS);
      if (rolling.rollingTrades >= 3 && rolling.rollingWinRate < 40.0) {
        demoteWhale(whale.id);
        console.log(`[WhalePruner] 📉 ROLLING ALPHA DECAY: ${whale.label} diturunkan ke [PROBATION] (7d Win Rate: ${rolling.rollingWinRate.toFixed(1)}% dari ${rolling.rollingTrades} trades).`);
        const decayMsg = `📉 *ALPHA DECAY DETECTED: PAUS DIISTIRAHATKAN!*\n\n` +
          `Dompet *${whale.label}* mengalami penurunan performa dalam ${CONFIG.ROLLING_WINDOW_DAYS} hari terakhir:\n` +
          `• Win Rate ${CONFIG.ROLLING_WINDOW_DAYS} Hari: *${rolling.rollingWinRate.toFixed(1)}%* (${rolling.rollingWins}W / ${rolling.rollingLosses}L)\n` +
          `• PnL ${CONFIG.ROLLING_WINDOW_DAYS} Hari: *${rolling.rollingPnlSol >= 0 ? '+' : ''}${rolling.rollingPnlSol.toFixed(4)} SOL*\n` +
          `• Status Baru: *PROBATION (SHADOW MODE)* 🔬\n\n` +
          `_Bot membekukan auto-copy dompet ini demi melindungi modal Anda dari rotasi gaya pasar yang tidak lagi cocok._`;
        await notify(decayMsg);
      }
    }
  }

  let prunedCount = 0;

  // 2. Live On-Chain Solvency Check: Auto-eliminate drained / dead wallets (< 0.2 SOL)
  for (const whale of allWhales) {
    if (getAllWhales().length <= 3) break; // Don't prune below safety minimum
    try {
      const pubkey = new PublicKey(whale.address);
      const lamports = await connection.getBalance(pubkey);
      const balanceSol = lamports / 1_000_000_000;

      if (balanceSol < 0.2) {
        const removed = removeWhale(whale.id, 'Saldo Habis / Dompet Ditinggalkan (< 0.2 SOL)');
        if (removed) {
          prunedCount++;
          console.log(`[WhalePruner] 🗑️ AUTO-ELIMINASI (SALDO KOSONG): ${whale.label} (${whale.address}) Saldo: ${balanceSol.toFixed(3)} SOL`);
          await notify(`🗑️ *DOMPET PAUS DIELIMINASI OTOMATIS: SALDO HABIS*\n\n` +
            `🏷️ *Label:* ${whale.label} [${whale.tier || 'PROBATION'}]\n` +
            `📝 *Alamat:* \`${whale.address}\`\n` +
            `💰 *Sisa Saldo On-Chain:* *${balanceSol.toFixed(3)} SOL* (Dompet telah dikosongkan/mati)\n\n` +
            `_Sistem Auto-Substitution langsung menggantikannya dengan kandidat baru._`
          );
        }
      }
    } catch {}
  }

  const badWhales = getWhalesForPruning(
    CONFIG.AUTO_PRUNE_INACTIVE_HOURS, 
    CONFIG.MAX_CONSECUTIVE_LOSSES_PRUNE,
    CONFIG.MIN_WINRATE_PCT
  );

  for (const whale of badWhales) {
    if (getAllWhales().length <= 3) break; // Don't prune below safety minimum

    let reason = '';
    const pruneThreshold = CONFIG.MAX_CONSECUTIVE_LOSSES_PRUNE || 4;
    if (whale.consecutive_losses >= pruneThreshold) {
      reason = `Performa Buruk Kronis (${whale.consecutive_losses}x Stop-Loss Berturut-turut)`;
    } else if (whale.total_trades_copied >= 4 && whale.win_rate < CONFIG.MIN_WINRATE_PCT) {
      reason = `Win Rate Rendah (${whale.win_rate.toFixed(1)}% < ${CONFIG.MIN_WINRATE_PCT}% dari ${whale.total_trades_copied} trade)`;
    } else {
      reason = `Tidak Aktif (> ${CONFIG.AUTO_PRUNE_INACTIVE_HOURS} jam tanpa transaksi)`;
    }

    const removed = removeWhale(whale.id, reason);
    if (removed) {
      prunedCount++;
      console.log(`[WhalePruner] 🗑️ DIELIMINASI: ${whale.label} (${whale.address}) - Alasan: ${reason}`);

      const pruneMsg = `🗑️ *DOMPET PAUS RESMI DIELIMINASI DARI RADAR!*\n\n` +
        `🏷️ *Label:* ${whale.label} [${whale.tier || 'PROBATION'}]\n` +
        `📝 *Alamat:* \`${whale.address}\`\n` +
        `⚠️ *Alasan:* *${reason}*\n` +
        `📊 *Statistik:* ${whale.wins || 0}W / ${whale.losses || 0}L (Winrate: *${whale.win_rate?.toFixed(1) || 0}%*) | PnL: *${whale.total_pnl_sol >= 0 ? '+' : ''}${whale.total_pnl_sol?.toFixed(4) || 0} SOL*\n\n` +
        `_Bot menjaga standar kualitas radar trading agar hanya dompet paling menguntungkan yang dipertahankan._`;

      await notify(pruneMsg);
    }
  }

  if (prunedCount > 0) {
    console.log(`[WhalePruner] ✂️ Berhasil mengeliminasi ${prunedCount} dompet berkinerja buruk.`);
  }

  // Auto-Substitution Engine: Auto-promote top queue candidates into freed slots
  let substitutedCount = 0;
  const currentCount = getAllWhales().length;
  const availableSlots = CONFIG.MAX_ACTIVE_WHALES - currentCount;

  if (availableSlots > 0) {
    for (let i = 0; i < availableSlots; i++) {
      const promoted = promoteQueueWhaleToActive();
      if (!promoted) break; // Queue is empty

      substitutedCount++;
      console.log(`[WhalePruner] 🔄 AUTO-SUBSTITUTION: ${promoted.label} (${promoted.address}) dipromosikan dari Shadow Queue ke Radar Aktif.`);
      const subMsg = `🔄 *AUTO-SUBSTITUTION: SMART MONEY DIPROMOSIKAN DARI BANGKU CADANGAN!*\n\n` +
        `Slot radar terbuka setelah pembersihan dompet berkinerja buruk. Kandidat teratas dari Shadow Queue otomatis dipromosikan:\n\n` +
        `🏷️ *Paus Baru:* ${promoted.label} [${promoted.tier}]\n` +
        `📝 *Alamat:* \`${promoted.address}\`\n` +
        `🛡️ *Status Copy:* *OFF (Masa Percobaan / Shadow Tracking)* 🔬\n` +
        `⚡ *Pipa Pemantauan:* Langsung terhubung ke WebSocket Solana RPC (<400ms).\n\n` +
        `_Bot menjaga kapasitas alpha radar selalu prima dengan rotasi otomatis tanpa jeda!_`;
      await notify(subMsg);
    }
  }

  if (prunedCount > 0 || substitutedCount > 0) {
    refreshWhaleSubscriptions();
  }

  return prunedCount;
}

// Background Scout & Pruner Loop
let scoutInterval: NodeJS.Timeout | null = null;

export function startWhaleScout() {
  if (scoutInterval) return;
  if (!CONFIG.AUTO_WHALE_DISCOVERY) {
    console.log('[WhaleScout] ℹ️ Auto-Whale Discovery dimatikan di konfigurasi.');
    return;
  }

  console.log(`[WhaleScout] 🚀 Autonomous Scout & Pruner aktif (Pemeriksaan berkala tiap ${CONFIG.WHALE_DISCOVERY_INTERVAL_MIN} menit).`);

  // Initial check after 15 seconds of startup
  setTimeout(async () => {
    try {
      await pruneUnderperformingWhales();
      const count = getAllWhales().length;
      const queueLen = getWhaleQueue().length;
      if (count < CONFIG.MAX_ACTIVE_WHALES || queueLen < 5) {
        await scoutTrendingWhales(CONFIG.WHALE_SCOUT_BATCH_SIZE || 4);
      }
    } catch {}
  }, 15000);

  // Periodic recurring check
  scoutInterval = setInterval(async () => {
    try {
      await pruneUnderperformingWhales();
      const count = getAllWhales().length;
      const queueLen = getWhaleQueue().length;
      if (count < CONFIG.MAX_ACTIVE_WHALES || queueLen < 10) {
        await scoutTrendingWhales(CONFIG.WHALE_SCOUT_BATCH_SIZE || 4);
      }
    } catch (err: any) {
      console.error('[WhaleScout] Error in recurring scout loop:', err.message);
    }
  }, CONFIG.WHALE_DISCOVERY_INTERVAL_MIN * 60 * 1000);
}

export function stopWhaleScout() {
  if (scoutInterval) {
    clearInterval(scoutInterval);
    scoutInterval = null;
  }
}
