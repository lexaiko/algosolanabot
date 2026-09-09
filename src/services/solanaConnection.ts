import { Connection } from '@solana/web3.js';
import { CONFIG } from '../config';

export interface RpcEndpoint {
  key: string;
  rpcUrl: string;
  wsUrl: string;
  connection: Connection;
}

const endpoints: RpcEndpoint[] = [];
let roundRobinIndex = 0;

function initEndpoints() {
  if (endpoints.length > 0) return;

  const rawKeys = CONFIG.HELIUS_API_KEYS;
  if (rawKeys.length > 0) {
    for (let i = 0; i < rawKeys.length; i++) {
      const key = rawKeys[i];
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${key}`;
      const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
      endpoints.push({
        key,
        rpcUrl,
        wsUrl,
        connection: new Connection(rpcUrl, {
          commitment: 'confirmed',
          wsEndpoint: wsUrl
        })
      });
      console.log(`[ConnectionPool] 🔑 Endpoint #${i + 1} terdaftar: ...${key.slice(-8)}`);
    }
  } else {
    // Fallback to single configured RPC URL
    const rpcUrl = CONFIG.SOLANA_RPC_URL;
    const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    endpoints.push({
      key: 'DEFAULT',
      rpcUrl,
      wsUrl,
      connection: new Connection(rpcUrl, {
        commitment: 'confirmed',
        wsEndpoint: wsUrl
      })
    });
  }

  console.log(`[ConnectionPool] 🌐 Helius Round-Robin Pool aktif dengan ${endpoints.length} API Key.`);
}

// Initialize on module load
initEndpoints();

/**
 * Returns a Connection instance rotated in round-robin fashion for RPC queries.
 * Every HTTP call will alternate between the available Helius API keys!
 */
export function getSolanaConnection(): Connection {
  if (endpoints.length === 0) initEndpoints();
  const endpoint = endpoints[roundRobinIndex % endpoints.length];
  roundRobinIndex = (roundRobinIndex + 1) % endpoints.length;
  return endpoint.connection;
}

/**
 * Returns a dedicated connection for long-lived WebSocket listeners to isolate traffic.
 * - WHALE_TRACKER: Dedicated Key 1
 * - POSITION_MANAGER: Dedicated Key 2
 */
export function getDedicatedConnection(purpose: 'WHALE_TRACKER' | 'POSITION_MANAGER' | 'GENERAL'): Connection {
  if (endpoints.length === 0) initEndpoints();
  if (endpoints.length === 1) return endpoints[0].connection;

  if (purpose === 'WHALE_TRACKER') {
    return endpoints[0].connection; // Key 1
  } else if (purpose === 'POSITION_MANAGER') {
    return endpoints[1 % endpoints.length].connection; // Key 2
  }

  return getSolanaConnection();
}

/**
 * Returns dedicated endpoint details (URLs, key) for a specific purpose.
 */
export function getDedicatedEndpoint(purpose: 'WHALE_TRACKER' | 'POSITION_MANAGER' | 'GENERAL'): RpcEndpoint {
  if (endpoints.length === 0) initEndpoints();
  if (endpoints.length === 1) return endpoints[0];

  if (purpose === 'WHALE_TRACKER') {
    return endpoints[0];
  } else if (purpose === 'POSITION_MANAGER') {
    return endpoints[1 % endpoints.length];
  }

  return endpoints[roundRobinIndex % endpoints.length];
}

/**
 * Export default primary connection proxy for backward compatibility.
 * Any call to connection.<method>(...) rotates across all API keys automatically!
 */
export const connection: Connection = new Proxy({} as Connection, {
  get(_target, prop) {
    const conn = getSolanaConnection();
    const value = (conn as any)[prop];
    return typeof value === 'function' ? value.bind(conn) : value;
  }
});
