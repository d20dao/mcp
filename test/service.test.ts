import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliResult, CircleRunner } from '../src/circle.js';
import { loadConfig } from '../src/config.js';
import { Ledger } from '../src/ledger.js';
import { paymentIdOf } from '../src/recovery.js';
import { D20Service } from '../src/service.js';

const WALLET = '0x2222222222222222222222222222222222222222';
const PAYER = '0x1111111111111111111111111111111111111111';
const PAY_URL = 'https://api.d20dao.org/v1/random';
const fixture = JSON.parse(await readFile(new URL('./fixtures/pay-fulfilled.json', import.meta.url), 'utf8'));
const fulfilled = fixture.data.response;
const PAYMENT_ID: string = fulfilled.paymentId;

const ok = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ data }), stderr: '', json: { data } as any });
const fail = (code: string, message: string, hint?: string): CliResult => {
  const error = hint ? { code, message, hint } : { code, message };
  return { code: 1, stdout: JSON.stringify({ error }), stderr: `Error: ${message}\n`, json: { error } };
};
const json = (status: number, body: unknown) => ({ status, body });

interface Setup {
  pay?: (args: string[], logDir: string) => CliResult | Promise<CliResult>;
  balances?: { domain: number; balance: string }[];
  api?: (url: string, init?: RequestInit) => { status: number; body: unknown } | 'network-error';
  env?: Record<string, string>;
  noCli?: boolean;
  home?: string;
  /** Reads of the spending record fail after the reservation, as a locked file would. */
  ledgerReadFails?: boolean;
}

async function setup(options: Setup = {}) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'd20-mcp-')));
  const logDir = await mkdtemp(join(tmpdir(), 'd20-payments-'));
  const calls: string[][] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const run: CircleRunner = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'wallet' && b === 'list') return ok({ wallets: [{ type: 'agent', address: WALLET, blockchain: args[3] }] });
    if (a === 'gateway' && b === 'balance') return ok({ balances: options.balances ?? [{ network: 'Arc', domain: 26, balance: '0.450000' }] });
    if (a === 'services' && b === 'pay') return (options.pay ?? (() => ok(fixture.data)))(args, logDir);
    if (a === 'wallet' && b === 'status') return ok({ type: 'agent', mainnet: { tokenStatus: 'VALID' }, testnet: { tokenStatus: 'NOT_LOGGED_IN' } });
    throw new Error(`unexpected CLI call ${args.join(' ')}`);
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const answer = options.api?.(url, init) ?? json(404, { error: { code: 'not_found', message: 'no such payment' } });
    if (answer === 'network-error') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  let clock = 1_000_000;
  const ledger = new Ledger(home);
  if (options.ledgerReadFails) {
    ledger.read = async () => {
      throw new Error('EBUSY: resource busy or locked');
    };
  }
  const service = new D20Service({
    config: loadConfig({ D20_MCP_HOME: home, ...options.env }),
    cli: () => (options.noCli ? { error: 'The Circle CLI is not installed.' } : { run, path: 'circle', version: '1.1.3' }),
    ledger,
    fetch: fetchImpl,
    paymentLogDir: logDir,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { service, calls, requests, ledger, logDir, advance: (ms: number) => (clock += ms) };
}

const payCalls = (calls: string[][]) => calls.filter((c) => c[0] === 'services' && c[1] === 'pay');
const spent = async (ledger: Ledger) => (await ledger.read()).spentAtomic;

const SELLER = '0x7C9a886c485a33a9636A685c867EaFBD15515e86';

/** A payment log in the shape the Circle CLI writes. */
function paymentLog(overrides: Record<string, unknown> = {}, nonce = '0x' + '12'.repeat(32)) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    url: PAY_URL,
    method: 'POST',
    address: WALLET,
    blockchain: 'ARC',
    payment: { amount: '$0.05 USDC', chain: 'Arc', scheme: 'GatewayWalletBatched', seller: SELLER },
    paymentHeader: 'SIGNED',
    paymentPayload: { payload: { authorization: { from: PAYER, nonce } }, accepted: { network: 'eip155:5042' } },
    ...overrides,
  });
}

/** A pay that fails after the CLI saved the signed payment, as the real CLI does. */
function savedThenFailed(message: string, log?: string, code = 'INTERNAL') {
  return async (_args: string[], logDir: string) => {
    await writeFile(join(logDir, `payment-${Date.now()}-${Math.random()}.json`), log ?? paymentLog());
    return fail(code, message, 'PAYMENT WAS SUBMITTED - funds may have moved.');
  };
}

describe('draw: paying', () => {
  it('reserves the price, pays once through the CLI and returns the proven result', async () => {
    const { service, calls, ledger } = await setup();
    const outcome = await service.draw({ operation: 'dice', sides: 20, count: 2, seed: 'mcp-test-1' });
    expect(outcome.ok).toBe(true);
    expect(outcome.data).toMatchObject({ status: 'fulfilled', result: [3, 3], requestId: '23', paymentId: PAYMENT_ID, charged: true, paid: { chain: 'ARC', leftToday: '0.95 USDC' } });
    expect(outcome.data.proof).toMatch(/^https:\/\/d20dao\.org\/explorer\/request\//);
    expect(payCalls(calls)).toEqual([
      [
        'services', 'pay', PAY_URL, '-X', 'POST', '-d', '{"operation":"dice","sides":20,"count":2,"seed":"mcp-test-1"}',
        '--address', WALLET, '--chain', 'ARC', '--max-amount', '0.05', '--timeout', '40', '--output', 'json',
      ],
    ]);
    expect(await spent(ledger)).toBe(50_000n);
  });

  it('finishes a pending (202) draw by reading the free status route, never by paying again', async () => {
    let reads = 0;
    const pending = { status: 'pending', stage: 'requesting', paymentId: PAYMENT_ID, retryAfterSeconds: 3, network: 'arc-mainnet' };
    const { service, calls, requests } = await setup({
      pay: () => ok({ response: pending, payment: fixture.data.payment }),
      api: () => (++reads < 3 ? json(200, pending) : json(200, fulfilled)),
    });
    const outcome = await service.draw({ operation: 'dice', sides: 20, count: 2 });
    expect(outcome.data).toMatchObject({ status: 'fulfilled', charged: true });
    expect(payCalls(calls)).toHaveLength(1);
    expect(requests.every((r) => r.url === `https://api.d20dao.org/v1/payments/${PAYMENT_ID}`)).toBe(true);
  });

  it('hands back a draw still pending after the short wait, with its paymentId', async () => {
    const pending = { status: 'pending', stage: 'settling', paymentId: PAYMENT_ID, retryAfterSeconds: 'soon', network: 'arc-mainnet' };
    const { service, requests } = await setup({ pay: () => ok({ response: pending, payment: fixture.data.payment }), api: () => json(200, pending) });
    const outcome = await service.draw({ operation: 'coinFlip' });
    expect(outcome.ok).toBe(true);
    expect(outcome.data).toMatchObject({ status: 'pending', paymentId: PAYMENT_ID, charged: true });
    expect(String(outcome.data.next)).toMatch(/get_result/);
    expect(requests.length).toBeLessThanOrEqual(8);
  });

  it('adds picked labels to a result read back from the status route', async () => {
    const pending = { status: 'pending', paymentId: PAYMENT_ID, retryAfterSeconds: 2, network: 'arc-mainnet' };
    const { service } = await setup({
      pay: () => ok({ response: pending, payment: fixture.data.payment }),
      api: () => json(200, { ...fulfilled, operation: 'chooseMany', result: [2, 0] }),
    });
    expect((await service.draw({ operation: 'chooseMany', items: ['ana', 'bo', 'cy'], count: 2 })).data.picked).toEqual(['cy', 'ana']);
  });

  it('counts a rejected payment as not charged and a refund_due one as charged', async () => {
    const rejected = await setup({ pay: () => ok({ response: { ...fulfilled, status: 'rejected' }, payment: fixture.data.payment }) });
    const r = await rejected.service.draw({ operation: 'coinFlip' });
    expect(r.data).toMatchObject({ charged: false });
    expect(r.data.paid).toBeUndefined();
    expect(await spent(rejected.ledger)).toBe(0n);

    const due = await setup({ pay: () => ok({ response: { ...fulfilled, status: 'refund_due' }, payment: fixture.data.payment }) });
    const d = await due.service.draw({ operation: 'coinFlip' });
    expect(d).toMatchObject({ ok: false, data: { charged: true } });
    expect(await spent(due.ledger)).toBe(50_000n);
  });

  it('treats paid output as paid even when the CLI exits non-zero', async () => {
    const { service } = await setup({ pay: () => ({ ...ok(fixture.data), code: 1 }) });
    expect((await service.draw({ operation: 'coinFlip' })).data).toMatchObject({ status: 'fulfilled', charged: true });
  });

  it('warns on the paying call itself when the CLI reports a different seller, then stops', async () => {
    const home = await mkdtemp(join(tmpdir(), 'd20-mcp-'));
    const { service, calls } = await setup({ home, pay: () => ok({ ...fixture.data, payment: { ...fixture.data.payment, seller: '0x9999999999999999999999999999999999999999' } }) });
    const first = await service.draw({ operation: 'coinFlip', seed: 'a' });
    expect(first.ok).toBe(false);
    expect(String(first.data.warning)).toMatch(/not the D20DAO seller/);
    expect(first.data.charged).toBe(true);

    const next = await service.draw({ operation: 'coinFlip', seed: 'b' });
    expect(next.data).toMatchObject({ charged: false });
    expect(payCalls(calls)).toHaveLength(1);

    // The halt outlives the process: a fresh service on the same home refuses too.
    const restarted = await setup({ home });
    expect((await restarted.service.draw({ operation: 'coinFlip', seed: 'c' })).data).toMatchObject({ charged: false });
    expect(payCalls(restarted.calls)).toHaveLength(0);
  });

  it('counts a payment the CLI reports as charged even when the answer is unreadable', async () => {
    const { service, ledger } = await setup({ pay: () => ok({ payment: fixture.data.payment, response: 'not json' }) });
    const outcome = await service.draw({ operation: 'coinFlip' });
    expect(outcome).toMatchObject({ ok: false, data: { charged: true } });
    expect(JSON.stringify(outcome.data)).not.toMatch(/eyJzdWNjZXNz/);
    expect(await spent(ledger)).toBe(50_000n);
  });

  it('reports the budget as unknown rather than zero when the record cannot be read', async () => {
    const { service } = await setup({ ledgerReadFails: true });
    const outcome = await service.draw({ operation: 'coinFlip' });
    expect(outcome.data.paid).toMatchObject({ leftToday: 'unknown' });
  });
});

describe('draw: failures', () => {
  it('reports a failure before signing as not charged, with the next step', async () => {
    const { service, ledger } = await setup({ pay: () => fail('INVALID_ARGUMENT', 'Insufficient Gateway balance for $0.05 payment.') });
    const outcome = await service.draw({ operation: 'coinFlip' });
    expect(outcome.data).toMatchObject({ charged: false });
    expect(String(outcome.data.error)).toMatch(/circle gateway deposit --chain ARC/);
    expect(await spent(ledger)).toBe(0n);
  });

  it('asks the user to accept Circle terms and never suggests the env var', async () => {
    const { service } = await setup({
      pay: () => fail('PERMISSION_DENIED', 'Circle CLI Terms acceptance is required before use.', 'Set CIRCLE_ACCEPT_TERMS=1 to accept in non-interactive shells.'),
    });
    const text = JSON.stringify((await service.draw({ operation: 'coinFlip' })).data);
    expect(text).toMatch(/user has to accept Circle's terms/);
    expect(text).not.toMatch(/CIRCLE_ACCEPT_TERMS/);
  });

  it('treats a killed CLI, a timeout or unreadable output as unknown and keeps the reservation', async () => {
    for (const result of [
      { code: null, killed: true, stdout: '', stderr: '' } as CliResult,
      fail('TIMEOUT', 'The operation was aborted due to timeout'),
      { code: 1, stdout: 'Segmentation fault', stderr: '' } as CliResult,
    ]) {
      const { service, ledger } = await setup({ pay: () => result });
      const outcome = await service.draw({ operation: 'coinFlip' });
      expect(outcome.data).toMatchObject({ charged: 'unknown' });
      expect(String(outcome.data.next)).toMatch(/Do not draw again/);
      expect(await spent(ledger)).toBe(50_000n);
    }
  });

  it('recovers a lost answer by resending the signed payment the CLI saved', async () => {
    const id = paymentIdOf(5042n, PAYER, '0x' + '12'.repeat(32));
    const { service, requests, ledger } = await setup({
      pay: savedThenFailed('Payment submitted but paid request failed.'),
      api: (url, init) => (url === PAY_URL && init?.method === 'POST' ? json(200, { ...fulfilled, paymentId: id }) : json(404, {})),
    });
    const outcome = await service.draw({ operation: 'dice', sides: 6 });
    expect(outcome.data).toMatchObject({ status: 'fulfilled', paymentId: id, charged: true });
    const resend = requests.find((r) => r.init?.method === 'POST')!;
    expect(resend.init?.body).toBe('{"operation":"dice","sides":6}');
    expect((resend.init?.headers as Record<string, string>)['payment-signature']).toBe('SIGNED');
    expect(await spent(ledger)).toBe(50_000n);
  });

  it('releases the reservation when the resent payment is refused, and says so with the paymentId', async () => {
    const { service, ledger } = await setup({
      pay: savedThenFailed('Payment submitted but request failed with HTTP 503.'),
      api: () => json(503, { error: { code: 'temporarily_unavailable', message: 'you were not charged, try again later' } }),
    });
    const outcome = await service.draw({ operation: 'raw' });
    expect(outcome.data).toMatchObject({ charged: false });
    expect(outcome.data.paymentId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(String(outcome.data.error)).not.toMatch(/funds may have moved/);
    expect(await spent(ledger)).toBe(0n);
  });

  it('treats a pending payment answer on the resend as not charged', async () => {
    const { service, ledger } = await setup({
      pay: savedThenFailed('Payment submitted but paid request failed.'),
      api: () => json(409, { error: { code: 'payment_pending', message: 'earlier payments are still being confirmed' } }),
    });
    const outcome = await service.draw({ operation: 'raw' });
    expect(outcome.data).toMatchObject({ charged: false });
    expect(await spent(ledger)).toBe(0n);
  });

  it('ignores a payment log from another call', async () => {
    const cases = [
      paymentLog({ timestamp: new Date(Date.now() - 20 * 60_000).toISOString() }),
      paymentLog({ url: 'https://api-testnet.d20dao.org/v1/random' }),
      paymentLog({ method: 'GET' }),
      paymentLog({ address: '0x3333333333333333333333333333333333333333' }),
      paymentLog({ blockchain: 'BASE' }),
      paymentLog({ payment: { amount: '$10.05 USDC', seller: SELLER } }),
    ];
    for (const log of cases) {
      const { service, requests, ledger } = await setup({ pay: savedThenFailed('Payment submitted but paid request failed.', log) });
      const outcome = await service.draw({ operation: 'raw' });
      expect(outcome.data).toMatchObject({ charged: 'unknown' });
      expect(outcome.data.paymentId).toBeUndefined();
      expect(requests).toHaveLength(0);
      expect(await spent(ledger)).toBe(50_000n);
    }
  });

  it('stops and warns when a payment of this call went to another seller', async () => {
    const wrong = paymentLog({ payment: { amount: '$0.05 USDC', seller: '0x9999999999999999999999999999999999999999' } });
    const { service, requests, calls } = await setup({ pay: savedThenFailed('Payment submitted but paid request failed.', wrong) });
    const outcome = await service.draw({ operation: 'raw' });
    expect(outcome.ok).toBe(false);
    expect(String(outcome.data.warning)).toMatch(/not the D20DAO seller/);
    expect(requests).toHaveLength(0);
    expect((await service.draw({ operation: 'coinFlip' })).data).toMatchObject({ charged: false });
    expect(payCalls(calls)).toHaveLength(1);
  });

  it('refuses to guess when several payments were saved during one call', async () => {
    const { service, requests } = await setup({
      pay: async (_args, logDir) => {
        await writeFile(join(logDir, 'payment-a.json'), paymentLog());
        await writeFile(join(logDir, 'payment-b.json'), paymentLog({}, '0x' + '34'.repeat(32)));
        return fail('INTERNAL', 'Payment submitted but paid request failed.', 'PAYMENT WAS SUBMITTED - funds may have moved.');
      },
    });
    const outcome = await service.draw({ operation: 'raw' });
    expect(outcome.data).toMatchObject({ charged: 'unknown' });
    expect(String(outcome.data.detail)).toMatch(/Several signed payments/);
    expect(requests).toHaveLength(0);
  });

  it('does not claim a failure was free when a signed payment was saved anyway', async () => {
    // The CLI only saves a payment after signing, so this pairing should not happen; if it ever
    // does, the safe reading is that money may have moved.
    const { service, requests, ledger } = await setup({
      pay: savedThenFailed('Insufficient Gateway balance for $0.05 payment.', paymentLog(), 'INVALID_ARGUMENT'),
    });
    const outcome = await service.draw({ operation: 'raw' });
    expect(outcome.data).toMatchObject({ charged: 'unknown' });
    expect(outcome.data.paymentId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(requests).toHaveLength(0);
    expect(await spent(ledger)).toBe(50_000n);
  });

  it('reports a failure before signing as not charged when no payment was saved', async () => {
    const { service, requests, ledger } = await setup({ pay: () => fail('INVALID_ARGUMENT', 'Insufficient Gateway balance for $0.05 payment.') });
    const outcome = await service.draw({ operation: 'raw' });
    expect(outcome.data).toMatchObject({ charged: false });
    expect(requests).toHaveLength(0);
    expect(await spent(ledger)).toBe(0n);
  });

  it('stays unknown when the resend fails or conflicts', async () => {
    for (const answer of ['network-error', json(409, { error: { code: 'payment_conflict', message: 'x' } }), json(500, { error: {} })] as const) {
      const { service, ledger } = await setup({ pay: savedThenFailed('Payment submitted but paid request failed.'), api: () => answer });
      const outcome = await service.draw({ operation: 'raw' });
      expect(outcome.data).toMatchObject({ charged: 'unknown' });
      expect(outcome.data.paymentId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(await spent(ledger)).toBe(50_000n);
    }
  });

  it('ignores payment logs that were there before the call', async () => {
    const { service, logDir } = await setup({ pay: () => fail('TIMEOUT', 'aborted') });
    await writeFile(join(logDir, 'payment-old.json'), JSON.stringify({ url: PAY_URL, paymentHeader: 'OLD', paymentPayload: { payload: { authorization: { from: PAYER, nonce: '0x' + '99'.repeat(32) } }, accepted: { network: 'eip155:5042' } } }));
    const outcome = await service.draw({ operation: 'raw' });
    expect(outcome.data).toMatchObject({ charged: 'unknown' });
    expect(outcome.data.paymentId).toBeUndefined();
  });

  it('reports nothing paid when the API did not ask for payment', async () => {
    const { service, ledger } = await setup({ pay: () => ok({ message: 'Endpoint returned HTTP 200 (no payment required).', response: '{}' }) });
    expect((await service.draw({ operation: 'raw' })).data).toMatchObject({ charged: false });
    expect(await spent(ledger)).toBe(0n);
  });
});

describe('draw: limits and repeats', () => {
  it('picks the first funded chain and asks for funding when none is', async () => {
    const funded = await setup({ balances: [{ domain: 26, balance: '0.01' }, { domain: 6, balance: '2' }] });
    await funded.service.draw({ operation: 'coinFlip' });
    expect(payCalls(funded.calls)[0]).toContain('BASE');

    const empty = await setup({ balances: [{ domain: 26, balance: '0.04' }] });
    const outcome = await empty.service.draw({ operation: 'coinFlip' });
    expect(outcome.data).toMatchObject({ charged: false });
    expect(String(outcome.data.error)).toMatch(/fund/);
    expect(payCalls(empty.calls)).toHaveLength(0);
  });

  it('stops at the daily limit before calling the CLI', async () => {
    const { service, calls } = await setup({ env: { D20_DAILY_LIMIT_USDC: '0.1' } });
    expect((await service.draw({ operation: 'coinFlip', seed: '1' })).ok).toBe(true);
    expect((await service.draw({ operation: 'coinFlip', seed: '2' })).ok).toBe(true);
    const third = await service.draw({ operation: 'coinFlip', seed: '3' });
    expect(String(third.data.error)).toMatch(/Daily limit/);
    expect(payCalls(calls)).toHaveLength(2);
  });

  it('does not pay when the spending record cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'd20-'));
    await writeFile(join(dir, 'blocker'), 'x');
    const { service, calls } = await setup({ home: join(dir, 'blocker', 'home') });
    const outcome = await service.draw({ operation: 'coinFlip' });
    expect(outcome.data).toMatchObject({ charged: false });
    expect(String(outcome.data.error)).toMatch(/paused/);
    expect(payCalls(calls)).toHaveLength(0);
  });

  it('returns the earlier draw for an identical call in flight or within five minutes', async () => {
    const { service, calls, advance } = await setup();
    const [a, b] = await Promise.all([service.draw({ operation: 'coinFlip' }), service.draw({ operation: 'coinFlip' })]);
    expect(a.data.paymentId).toBe(b.data.paymentId);
    const c = await service.draw({ operation: 'coinFlip' });
    expect(c.data.repeat).toMatch(/without paying again/);
    expect(payCalls(calls)).toHaveLength(1);

    await service.draw({ operation: 'coinFlip', seed: 'round 2' });
    expect(payCalls(calls)).toHaveLength(2);
    advance(240_000);
    await service.draw({ operation: 'coinFlip' });
    expect(payCalls(calls), 'still inside the window').toHaveLength(2);
    advance(61_000);
    await service.draw({ operation: 'coinFlip' });
    expect(payCalls(calls)).toHaveLength(3);
  });

  it('does not claim a repeat was a result when the first outcome is unknown', async () => {
    const { service, calls } = await setup({ pay: () => ({ code: null, killed: true, stdout: '', stderr: '' }) });
    await service.draw({ operation: 'coinFlip' });
    const again = await service.draw({ operation: 'coinFlip' });
    expect(again.data).toMatchObject({ charged: 'unknown' });
    expect(String(again.data.repeat)).toMatch(/already paid for moments ago/);
    expect(payCalls(calls)).toHaveLength(1);
  });

  it('lets a call that was not charged be tried again at once', async () => {
    let first = true;
    const { service, calls } = await setup({
      pay: () => {
        if (first) {
          first = false;
          return fail('INVALID_ARGUMENT', 'Insufficient Gateway balance for $0.05 payment.');
        }
        return ok(fixture.data);
      },
    });
    await service.draw({ operation: 'coinFlip' });
    expect((await service.draw({ operation: 'coinFlip' })).ok).toBe(true);
    expect(payCalls(calls)).toHaveLength(2);
  });

  it('runs paid draws one at a time', async () => {
    let active = 0;
    let peak = 0;
    const { service } = await setup({
      pay: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return ok(fixture.data);
      },
    });
    await Promise.all(['a', 'b', 'c'].map((seed) => service.draw({ operation: 'coinFlip', seed })));
    expect(peak).toBe(1);
  });

  it('rejects bad input without touching the CLI', async () => {
    const { service, calls } = await setup();
    expect(await service.draw({ operation: 'dice', sides: 1 })).toMatchObject({ ok: false, data: { field: 'sides', charged: false } });
    expect(calls).toHaveLength(0);
  });

  it('pays the testnet API when configured for testnet', async () => {
    const { service, calls } = await setup({ env: { D20_NETWORK: 'testnet' }, balances: [{ domain: 26, balance: '5' }] });
    await service.draw({ operation: 'coinFlip' });
    const [pay] = payCalls(calls);
    expect(pay).toContain('https://api-testnet.d20dao.org/v1/random');
    expect(pay).toContain('ARC-TESTNET');
  });
});

describe('setup_status', () => {
  it('reports ready with the paying chain', async () => {
    const { service } = await setup();
    expect((await service.setupStatus()).data).toMatchObject({ ready: true, wallet: WALLET, payChain: 'ARC', login: 'VALID' });
  });

  it('points to the Circle setup guide without a CLI', async () => {
    const { service } = await setup({ noCli: true });
    const outcome = await service.setupStatus();
    expect(outcome.data.ready).toBe(false);
    expect(String(outcome.data.nextStep)).toMatch(/agents\.circle\.com\/skills\/setup\.md/);
  });

  it('asks for a testnet login on testnet', async () => {
    const { service } = await setup({ env: { D20_NETWORK: 'testnet' } });
    expect(String((await service.setupStatus()).data.nextStep)).toMatch(/--testnet/);
  });

  it('is not ready when the configured chain has no balance', async () => {
    const { service } = await setup({ env: { D20_PAY_CHAIN: 'BASE' }, balances: [{ domain: 26, balance: '5' }, { domain: 6, balance: '0' }] });
    const outcome = await service.setupStatus();
    expect(outcome.data.ready).toBe(false);
    expect(String(outcome.data.nextStep)).toMatch(/BASE \(D20_PAY_CHAIN\)/);
  });

  it('is not ready while the spending record is damaged', async () => {
    const home = await mkdtemp(join(tmpdir(), 'd20-'));
    await writeFile(join(home, 'spend.json'), 'nope');
    const { service } = await setup({ home });
    const outcome = await service.setupStatus();
    expect(outcome.data.ready).toBe(false);
    expect(String(outcome.data.nextStep)).toMatch(/damaged/);
  });
});

describe('get_result', () => {
  it('needs exactly one id, treats empty strings as missing and reads for free', async () => {
    const { service, requests } = await setup({ api: () => json(200, fulfilled) });
    expect((await service.getResult({})).ok).toBe(false);
    expect((await service.getResult({ paymentId: '', requestId: '' })).ok).toBe(false);
    expect((await service.getResult({ paymentId: PAYMENT_ID, requestId: '' })).data).toMatchObject({ status: 'fulfilled', requestId: '23' });
    expect(requests.map((r) => r.url)).toEqual([`https://api.d20dao.org/v1/payments/${PAYMENT_ID}`]);
  });
});
