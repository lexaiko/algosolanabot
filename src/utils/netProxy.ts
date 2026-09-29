/**
 * Egress proxy bootstrap.
 *
 * Some sandboxed/VPS environments only allow outbound traffic through an
 * authenticated HTTP(S) proxy (HTTPS_PROXY/https_proxy). axios honors it
 * natively, but `ws` (used directly by marketStreamer AND internally by
 * @solana/web3.js) does not — raw wss:// connections then die with
 * EPROTO "wrong version number".
 *
 * This module patches the `ws` export in Node's require cache BEFORE any
 * consumer loads it, so every WebSocket transparently tunnels through the
 * proxy via HTTP CONNECT. It also exposes getProxyAgent() for Telegraf's
 * node-fetch client.
 *
 * No-op when no proxy env var is set: behavior is then 100% identical to
 * the unpatched bot.
 */
import { createRequire } from 'module';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || '';

let proxyAgent: HttpsProxyAgent<string> | undefined;

export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  if (!PROXY_URL) return undefined;
  if (!proxyAgent) {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
    console.log('[NetProxy] Egress proxy terdeteksi — WebSocket & Telegram akan di-tunnel via proxy.');
  }
  return proxyAgent;
}

function patchOneWs(require: NodeRequire, wsPath: string, agent: HttpsProxyAgent<string>): boolean {
  try {
    // Ensure the module is in require.cache (it may not be loaded yet —
    // netProxy runs before any consumer imports `ws`).
    if (!require.cache[wsPath]) {
      require(wsPath);
    }
    const cached = require.cache[wsPath];
    if (!cached) return false;
    const WS = cached.exports as any;
    if (WS && WS.__proxyPatched) return true;

    class ProxiedWebSocket extends WS {
      constructor(address: string, protocols?: any, options?: any) {
        // `ws` supports both (address, options) and (address, protocols, options).
        // Normalize so the proxy agent is never dropped by the 2-arg shifting.
        // NET-RESILIENCE (2026-09-29): handshakeTimeout dipaksa (default 15s)
        // supaya koneksi ke proxy yang mati tidak gantung selamanya dalam state
        // CONNECTING — itu yang bikin soket zombie menumpuk saat egress down.
        // Urutan spread: nilai eksplisit dari caller tetap menang.
        if (protocols && typeof protocols === 'object' && !Array.isArray(protocols)) {
          super(address, { handshakeTimeout: 15000, agent, ...protocols });
        } else {
          super(address, protocols, { handshakeTimeout: 15000, agent, ...(options || {}) });
        }
      }
    }
    (ProxiedWebSocket as any).__proxyPatched = true;

    cached.exports = ProxiedWebSocket;
    (cached.exports as any).default = ProxiedWebSocket;
    return true;
  } catch {
    return false;
  }
}

function patchWebSocketForProxy(): void {
  const agent = getProxyAgent();
  if (!agent) return;
  try {
    const require = createRequire(import.meta.url);
    const wsPaths = new Set<string>();
    // 1. Top-level `ws` (used by direct ESM/CJS consumers via require()).
    try {
      wsPaths.add(require.resolve('ws'));
    } catch {}
    // 2. Nested copies, e.g. rpc-websockets/node_modules/ws — this is the one
    // @solana/web3.js actually uses for the Helius WebSocket.
    try {
      const rwsPath = require.resolve('rpc-websockets');
      const rwsRequire = createRequire(rwsPath);
      wsPaths.add(rwsRequire.resolve('ws'));
    } catch {}
    let patched = 0;
    for (const wsPath of wsPaths) {
      if (patchOneWs(require, wsPath, agent)) patched++;
    }
    if (patched > 0) {
      console.log(`[NetProxy] Modul \`ws\` di-patch (${patched} lokasi): semua WebSocket via proxy.`);
    } else {
      console.warn('[NetProxy] Tidak ada modul `ws` yang berhasil di-patch.');
    }
  } catch (err: any) {
    console.warn('[NetProxy] Gagal patch modul ws:', err?.message);
  }
}

// Auto-run on import. index.ts imports this module FIRST so the patch
// lands before @solana/web3.js or marketStreamer touch `ws`.
patchWebSocketForProxy();
