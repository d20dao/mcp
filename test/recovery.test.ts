import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listPaymentLogs } from '../src/circle.js';
import { paymentIdOf, readPaymentLog, scanNewPaymentLogs } from '../src/recovery.js';

// Vectors from viem: keccak256(encodeAbiParameters([uint256, address, bytes32], [chainId, payer, nonce])).
const PAYER = '0x1111111111111111111111111111111111111111';
const NONCE = '0x' + 'ab'.repeat(32);
const EXPECTED = '0x26425507d88cb2b8d50d5c2d6904465ef20eea9de653670bd3382359dbeae826';
const URL = 'https://api.d20dao.org/v1/random';

const SELLER = '0x7C9a886c485a33a9636A685c867EaFBD15515e86';
const WALLET = '0x2222222222222222222222222222222222222222';
const expected = { url: URL, address: WALLET, blockchain: 'ARC', amountUsdc: '0.05', since: Date.now() - 1_000, until: Date.now() + 60_000 };

const log = (url: string, nonce = NONCE, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    timestamp: new Date().toISOString(),
    url,
    method: 'POST',
    address: WALLET,
    blockchain: 'ARC',
    payment: { amount: '$0.05 USDC', chain: 'Arc', scheme: 'GatewayWalletBatched', seller: SELLER },
    paymentHeader: 'eyJ4NDAyVmVyc2lvbiI6Mn0=',
    paymentPayload: { x402Version: 2, payload: { authorization: { from: PAYER, nonce }, signature: '0x00' }, accepted: { network: 'eip155:5042' } },
    ...overrides,
  });

describe('recovery', () => {
  it('derives the paymentId the API uses', () => {
    expect(paymentIdOf(5042n, PAYER, NONCE)).toBe(EXPECTED);
    expect(paymentIdOf(8453n, '0xABCDEF0123456789abcdef0123456789ABCDEF01', '0x' + '00'.repeat(31) + '01')).toBe(
      '0x56d1c8d72db5fea20adc37a311ef87a240076d58378cedb7a798e8858fbdf6cd',
    );
  });

  it('reads the signed payment from a CLI payment log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'd20-'));
    await writeFile(join(dir, 'payment-a.json'), log(URL));
    expect(await readPaymentLog(join(dir, 'payment-a.json'))).toMatchObject({ url: URL, paymentId: EXPECTED, paymentHeader: 'eyJ4NDAyVmVyc2lvbiI6Mn0=' });
  });

  it('only picks a log written during this call, for this call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'd20-'));
    await writeFile(join(dir, 'payment-2026-01-01.json'), log(URL, '0x' + '01'.repeat(32)));
    const before = await listPaymentLogs(dir);
    expect((await scanNewPaymentLogs(dir, before, expected, SELLER)).mine[0]).toBeUndefined();

    const rejected: [string, string][] = [
      ['another URL', log('https://elsewhere.example/v1/random')],
      ['not JSON', '{not json'],
      ['another price', log(URL, NONCE, { payment: { amount: '$5.00 USDC', seller: SELLER } })],
      ['a price that only contains the right digits', log(URL, NONCE, { payment: { amount: '$10.05 USDC', seller: SELLER } })],
      ['another wallet', log(URL, NONCE, { address: '0x3333333333333333333333333333333333333333' })],
      ['another chain', log(URL, NONCE, { blockchain: 'BASE' })],
      ['written after the call', log(URL, NONCE, { timestamp: new Date(Date.now() + 10 * 60_000).toISOString() })],
      ['another method', log(URL, NONCE, { method: 'GET' })],
      ['written before the call', log(URL, NONCE, { timestamp: new Date(Date.now() - 20 * 60_000).toISOString() })],
      ['no timestamp', log(URL, NONCE, { timestamp: undefined })],
    ];
    for (const [name, contents] of rejected) {
      await writeFile(join(dir, `payment-reject-${name.replace(/\W+/g, '-')}.json`), contents);
    }
    expect((await scanNewPaymentLogs(dir, before, expected, SELLER)).mine[0]).toBeUndefined();

    await writeFile(join(dir, 'payment-zzz-this-call.json'), log(URL));
    expect(((await scanNewPaymentLogs(dir, before, expected, SELLER)).mine[0])?.paymentId).toBe(EXPECTED);
  });

  it('treats a missing payments folder as empty', async () => {
    expect((await listPaymentLogs(join(tmpdir(), 'd20-none-' + Date.now()))).size).toBe(0);
  });
});
