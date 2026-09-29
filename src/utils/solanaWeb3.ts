/**
 * Centralized @solana/web3.js loader.
 *
 * web3.js is intentionally loaded through CJS `require()` instead of ESM
 * `import`. Reason: in egress-proxy environments, utils/netProxy patches the
 * `ws` module via require.cache so the Helius WebSocket (created deep inside
 * web3.js -> rpc-websockets -> ws) tunnels through the proxy. Under tsx, a
 * plain ESM `import '@solana/web3.js'` resolves the ESM build and bypasses
 * require.cache, silently dropping the patch and killing real-time ticks
 * with EPROTO "wrong version number" errors.
 *
 * Import web3.js names from here instead of '@solana/web3.js' directly.
 * Each name is exported twice (value + instance type), mirroring the
 * original `import { Connection } from '@solana/web3.js'` semantics.
 * Zero behavior change when no proxy is configured.
 */
import { createRequire } from 'module';
import type * as Web3 from '@solana/web3.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3js = require('@solana/web3.js') as typeof Web3;

type ConnectionCtor = typeof Web3.Connection;
export const Connection: ConnectionCtor = web3js.Connection;
export type Connection = InstanceType<ConnectionCtor>;

type PublicKeyCtor = typeof Web3.PublicKey;
export const PublicKey: PublicKeyCtor = web3js.PublicKey;
export type PublicKey = InstanceType<PublicKeyCtor>;

type SystemProgramCtor = typeof Web3.SystemProgram;
export const SystemProgram: SystemProgramCtor = web3js.SystemProgram;
export type SystemProgram = InstanceType<SystemProgramCtor>;

type TransactionInstructionCtor = typeof Web3.TransactionInstruction;
export const TransactionInstruction: TransactionInstructionCtor =
  web3js.TransactionInstruction;
export type TransactionInstruction = InstanceType<TransactionInstructionCtor>;

type ComputeBudgetProgramCtor = typeof Web3.ComputeBudgetProgram;
export const ComputeBudgetProgram: ComputeBudgetProgramCtor =
  web3js.ComputeBudgetProgram;
export type ComputeBudgetProgram = InstanceType<ComputeBudgetProgramCtor>;
