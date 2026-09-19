// When the paid request fails after the CLI signed the payment, the CLI saves the signed payment as
// a new file in its payments folder. This server compares that folder before and after each call,
// so it never has to parse error text (which can carry the API's own response body).
// The API keys every paid call by paymentId = keccak256(abi.encode(uint256 chainId, address payer, bytes32 nonce)),
// and resending the same signed payment with the same body returns that call instead of paying again.
//
// Another MCP server, or a hand-run `circle services pay`, writes into the same folder. Taking the
// wrong file would resend a stranger's payment for this body, so a log is only this call's when
// every recorded detail matches, and anything ambiguous is left alone.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { listPaymentLogs } from './circle.js';

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export function paymentIdOf(chainId: bigint, payer: string, nonce: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payer)) throw new Error('payer must be an address');
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error('nonce must be 32 bytes');
  return '0x' + bytesToHex(keccak_256(hexToBytes(word(chainId.toString(16)) + word(payer) + word(nonce))));
}

export interface SavedPayment {
  path: string;
  url: string;
  /** The Payment-Signature header value the CLI sent. */
  paymentHeader: string;
  paymentId: string;
  /** Who the CLI says it paid. */
  seller: string;
}

export interface PaymentLogMatch {
  /** The paid URL this server sent. */
  url: string;
  /** The wallet this server paid from. */
  address: string;
  /** The Circle CLI chain code this server paid on. */
  blockchain: string;
  /** The price in USDC, as a decimal string. */
  amountUsdc: string;
  /** Epoch milliseconds when the call started; the CLI's own timestamp may round a little earlier. */
  since: number;
  /** Epoch milliseconds when the call ended. */
  until: number;
}

/** The CLI's timestamp and this server's clock can differ by a rounding, not by a call. */
const CLOCK_SLACK_MS = 2_000;

const sameAddress = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** Reads a CLI payment log. With `expect`, it must be the payment of that exact call, seller aside. */
export async function readPaymentLog(path: string, expect?: PaymentLogMatch): Promise<SavedPayment> {
  const log = JSON.parse(await readFile(path, 'utf8'));
  const payload = log.paymentPayload ?? {};
  const authorization = payload.payload?.authorization;
  const chainId = /^eip155:(\d+)$/.exec(payload.accepted?.network ?? '')?.[1];
  if (typeof log.paymentHeader !== 'string' || !authorization?.from || !authorization?.nonce || !chainId) {
    throw new Error(`no signed payment in ${path}`);
  }
  if (expect) {
    const written = Date.parse(log.timestamp ?? '');
    const amount = /(\d+(?:\.\d+)?)/.exec(String(log.payment?.amount ?? ''))?.[1];
    const ok =
      log.url === expect.url &&
      (log.method ?? 'POST') === 'POST' &&
      sameAddress(log.address, expect.address) &&
      log.blockchain === expect.blockchain &&
      amount !== undefined &&
      Number(amount) === Number(expect.amountUsdc) &&
      Number.isFinite(written) &&
      written >= expect.since - CLOCK_SLACK_MS &&
      written <= expect.until + CLOCK_SLACK_MS;
    if (!ok) throw new Error(`${path} is another call's payment`);
  }
  return {
    path,
    url: log.url,
    paymentHeader: log.paymentHeader,
    paymentId: paymentIdOf(BigInt(chainId), authorization.from, authorization.nonce),
    seller: String(log.payment?.seller ?? ''),
  };
}

export interface ScannedPayments {
  /** Payments this call signed, newest first. More than one means the folder is ambiguous. */
  mine: SavedPayment[];
  /** Sellers other than the expected one, seen on payments of this call. */
  wrongSellers: string[];
}

/** The payments this call signed: files that were not there before and match it in every detail. */
export async function scanNewPaymentLogs(dir: string, before: Set<string>, expect: PaymentLogMatch, seller: string): Promise<ScannedPayments> {
  const added = [...(await listPaymentLogs(dir))].filter((name) => !before.has(name)).sort().reverse();
  const mine: SavedPayment[] = [];
  const wrongSellers: string[] = [];
  for (const name of added) {
    let saved: SavedPayment;
    try {
      saved = await readPaymentLog(join(dir, name), expect);
    } catch {
      continue; // Not this call's payment.
    }
    if (sameAddress(saved.seller, seller)) mine.push(saved);
    else wrongSellers.push(saved.seller || 'an unnamed address');
  }
  return { mine, wrongSellers };
}
