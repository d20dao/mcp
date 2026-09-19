import { homedir } from 'node:os';
import { join } from 'node:path';

export type Network = 'mainnet' | 'testnet';

/** The only endpoints this server pays. Nothing in a tool call can change them. */
export const API_BASE: Record<Network, string> = {
  mainnet: 'https://api.d20dao.org',
  testnet: 'https://api-testnet.d20dao.org',
};

/** Price per draw in USDC atomic units (6 decimals); the server refuses to pay more. */
export const PRICE_ATOMIC = 50_000n;
export const PRICE_USDC = '0.05';

/** The API's seller address on both networks. A payment to anyone else stops further draws. */
export const SELLER = '0x7C9a886c485a33a9636A685c867EaFBD15515e86';

/** Seconds the CLI waits for each HTTP answer; the API holds a paid call about 25 s before answering 202. */
export const CLI_HTTP_TIMEOUT_S = 40;
/** Hard stop for the CLI process, above its own worst case, so it can save a signed payment before exiting. */
export const CLI_PROCESS_TIMEOUT_MS = 150_000;
/** How long a draw keeps reading a pending call before handing back its paymentId. */
export const POLL_MS = 15_000;
/** Hard stop for the CLI's read-only commands, so a stuck one cannot hold up a draw. */
export const CLI_READ_TIMEOUT_MS = 20_000;
/**
 * An identical draw within this window returns the earlier one instead of paying again.
 * It covers the longest a draw can take, so an agent whose client timed out and retried
 * gets that draw back rather than a second payment.
 */
export const REPEAT_WINDOW_MS = 300_000;

/**
 * Circle CLI chain codes this server can pay from, with their Gateway domains, in order of
 * preference: Arc first, then the chains the CLI settles fastest.
 */
export const PAY_CHAINS: Record<Network, readonly { chain: string; domain: number }[]> = {
  mainnet: [
    { chain: 'ARC', domain: 26 },
    { chain: 'MATIC', domain: 7 },
    { chain: 'AVAX', domain: 1 },
    { chain: 'BASE', domain: 6 },
    { chain: 'ARB', domain: 3 },
    { chain: 'OP', domain: 2 },
    { chain: 'UNI', domain: 10 },
    { chain: 'ETH', domain: 0 },
  ],
  testnet: [
    { chain: 'ARC-TESTNET', domain: 26 },
    { chain: 'MATIC-AMOY', domain: 7 },
    { chain: 'AVAX-FUJI', domain: 1 },
    { chain: 'BASE-SEPOLIA', domain: 6 },
    { chain: 'ARB-SEPOLIA', domain: 3 },
    { chain: 'OP-SEPOLIA', domain: 2 },
    { chain: 'UNI-SEPOLIA', domain: 10 },
    { chain: 'ETH-SEPOLIA', domain: 0 },
  ],
};

export const SETUP_URL = 'https://agents.circle.com/skills/setup.md';
export const FUND_URL = 'https://agents.circle.com/skills/wallet-fund.md';

export interface Config {
  network: Network;
  apiBase: string;
  /** Pay from this CLI chain code instead of picking the first funded one. */
  payChain?: string;
  /** Pay from this agent wallet instead of the first one the CLI lists. */
  walletAddress?: string;
  /** Daily spending cap in USDC atomic units; 0 turns paid draws off. */
  dailyLimitAtomic: bigint;
  /** Path to the Circle CLI entry script, overriding the lookup on PATH. */
  circleCli?: string;
  /** Where the spending ledger lives. */
  home: string;
}

function usdcToAtomic(value: string, name: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error(`${name} must be a USDC amount like 1 or 0.25`);
  return BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = (env.D20_NETWORK ?? 'mainnet').trim().toLowerCase();
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('D20_NETWORK must be mainnet or testnet');
  const payChain = env.D20_PAY_CHAIN?.trim().toUpperCase() || undefined;
  if (payChain && !PAY_CHAINS[network].some((c) => c.chain === payChain)) {
    throw new Error(`D20_PAY_CHAIN must be one of ${PAY_CHAINS[network].map((c) => c.chain).join(', ')}`);
  }
  const walletAddress = env.D20_WALLET_ADDRESS?.trim() || undefined;
  if (walletAddress && !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) throw new Error('D20_WALLET_ADDRESS must be an EVM address');
  return {
    network,
    apiBase: API_BASE[network],
    payChain,
    walletAddress,
    dailyLimitAtomic: usdcToAtomic(env.D20_DAILY_LIMIT_USDC ?? '1', 'D20_DAILY_LIMIT_USDC'),
    circleCli: env.D20_CIRCLE_CLI?.trim() || undefined,
    home: env.D20_MCP_HOME?.trim() || join(homedir(), '.d20dao-mcp'),
  };
}

export function formatUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
