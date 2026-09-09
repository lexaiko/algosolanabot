import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { RugCheckResult } from '../types/index';
import { connection } from './solanaConnection';

const RUGCHECK_BASE_URL = 'https://api.rugcheck.xyz/v1/tokens';

export async function checkTokenSafety(tokenAddress: string): Promise<RugCheckResult> {
  const risks: string[] = [];
  let mintRevoked = false;
  let freezeRevoked = false;
  let lpBurnedOrLocked = true;
  let top10HoldersPct = 0;
  let calculatedScore = 85;
  let rugCheckDanger = false;

  try {
    // 1. Check via RugCheck API
    const res = await axios.get(`${RUGCHECK_BASE_URL}/${tokenAddress}/report`, {
      timeout: 7000
    });

    const data = res.data;
    if (data) {
      // RugCheck flags: rugged = true or danger risks
      if (data.rugged === true) {
        rugCheckDanger = true;
        risks.push('RugCheck flagged this token as RUGGED');
      }

      const riskList = data.risks || [];
      for (const r of riskList) {
        if (r.level === 'danger') {
          rugCheckDanger = true;
        }
        risks.push(`[${r.level?.toUpperCase() || 'WARN'}] ${r.name}`);
      }

      // Check Mint Authority
      mintRevoked = data.token?.mintAuthority === null || data.token?.mintAuthority === undefined;
      // Check Freeze Authority
      freezeRevoked = data.token?.freezeAuthority === null || data.token?.freezeAuthority === undefined;

      // Check Top Holders
      if (Array.isArray(data.topHolders)) {
        const top10 = data.topHolders.slice(0, 10);
        top10HoldersPct = top10.reduce((sum: number, h: any) => sum + (h.pct || 0), 0);
      }

      // Check LP
      if (Array.isArray(data.markets)) {
        const raydiumMarket = data.markets.find((m: any) => m.marketType === 'raydium' || m.lp);
        if (raydiumMarket?.lp) {
          lpBurnedOrLocked = (raydiumMarket.lp.lpLockedPct || 0) > 70 || raydiumMarket.lp.lpUnlocked === 0;
        }
      }

      // RugCheck score: lower is better (0-2000). Convert to 0-100 scale (100 = best)
      if (typeof data.score === 'number') {
        calculatedScore = Math.max(0, Math.min(100, Math.round(100 - (data.score / 20))));
      } else {
        let scoreDeduction = 0;
        if (!mintRevoked) scoreDeduction += 30;
        if (!freezeRevoked) scoreDeduction += 30;
        if (!lpBurnedOrLocked) scoreDeduction += 20;
        calculatedScore = Math.max(0, 100 - scoreDeduction);
      }
    }
  } catch (err: any) {
    // Fallback directly to Solana RPC check if RugCheck is temporarily down
    try {
      const pubkey = new PublicKey(tokenAddress);
      const accInfo = await connection.getParsedAccountInfo(pubkey);
      const parsedData = (accInfo.value?.data as any)?.parsed?.info;

      if (parsedData) {
        mintRevoked = parsedData.mintAuthority === null;
        freezeRevoked = parsedData.freezeAuthority === null;
        lpBurnedOrLocked = true;
        top10HoldersPct = 25;

        let score = 90;
        if (!mintRevoked) score -= 40;
        if (!freezeRevoked) score -= 40;
        calculatedScore = score;
      }
    } catch (rpcErr: any) {
      risks.push('RPC safety fallback error: ' + rpcErr.message);
    }
  }

  // Evaluate safety against hard rules
  let isSafe = true;

  if (rugCheckDanger) {
    isSafe = false;
  }
  if (CONFIG.REQUIRE_MINT_REVOKED && !mintRevoked) {
    isSafe = false;
    risks.push('Mint Authority is still ACTIVE (Dev can print infinite tokens)');
  }
  if (CONFIG.REQUIRE_FREEZE_REVOKED && !freezeRevoked) {
    isSafe = false;
    risks.push('Freeze Authority is still ACTIVE (Honeypot risk)');
  }
  if (CONFIG.REQUIRE_LP_BURNED && !lpBurnedOrLocked) {
    isSafe = false;
    risks.push('Liquidity is NOT burned or locked (Dev can pull liquidity)');
  }
  if (top10HoldersPct > CONFIG.MAX_TOP10_HOLDERS_PCT && calculatedScore < 80) {
    isSafe = false;
    risks.push(`Top 10 holders hold ${top10HoldersPct.toFixed(1)}% of total supply (High dump risk)`);
  }
  if (calculatedScore < CONFIG.MIN_RUGCHECK_SCORE) {
    isSafe = false;
    risks.push(`Security score (${calculatedScore}/100) below minimum threshold (${CONFIG.MIN_RUGCHECK_SCORE})`);
  }

  return {
    score: calculatedScore,
    isSafe,
    mintAuthorityRevoked: mintRevoked,
    freezeAuthorityRevoked: freezeRevoked,
    lpBurnedOrLocked,
    top10HoldersPct,
    risks
  };
}
