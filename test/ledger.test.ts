import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '../src/ledger.js';

const home = () => mkdtemp(join(tmpdir(), 'd20-ledger-'));

describe('Ledger', () => {
  it('reserves up to the cap and refuses beyond it', async () => {
    const ledger = new Ledger(await home());
    expect(await ledger.reserve(50_000n, 100_000n)).toMatchObject({ amountAtomic: 50_000n });
    expect(await ledger.reserve(50_000n, 100_000n)).toMatchObject({ amountAtomic: 50_000n });
    expect(await ledger.reserve(50_000n, 100_000n)).toEqual({ refusedAt: 100_000n });
    expect(await ledger.read()).toEqual({ spentAtomic: 100_000n, draws: 2 });
  });

  it('gives a released reservation back', async () => {
    const ledger = new Ledger(await home());
    const r = await ledger.reserve(50_000n, 100_000n);
    if ('refusedAt' in r) throw new Error('refused');
    await ledger.release(r);
    expect(await ledger.read()).toEqual({ spentAtomic: 0n, draws: 0 });
  });

  it('starts a new UTC day at zero and ignores releases from the day before', async () => {
    let now = new Date('2026-09-19T23:59:59Z');
    const ledger = new Ledger(await home(), () => now);
    const r = await ledger.reserve(50_000n, 50_000n);
    if ('refusedAt' in r) throw new Error('refused');
    now = new Date('2026-09-20T00:00:01Z');
    expect(await ledger.read()).toEqual({ spentAtomic: 0n, draws: 0 });
    expect(await ledger.reserve(50_000n, 50_000n)).toMatchObject({ day: '2026-09-20' });
    await ledger.release(r);
    expect(await ledger.read()).toEqual({ spentAtomic: 50_000n, draws: 1 });
  });

  it('keeps the cap across several ledgers on one folder (separate server processes)', async () => {
    const dir = await home();
    const ledgers = Array.from({ length: 4 }, () => new Ledger(dir));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => ledgers[i % 4]!.reserve(50_000n, 1_000_000n)));
    expect(results.filter((r) => !('refusedAt' in r))).toHaveLength(20);
    expect(await ledgers[0]!.read()).toEqual({ spentAtomic: 1_000_000n, draws: 20 });
  });

  it('refuses to guess when the record is damaged', async () => {
    const dir = await home();
    await writeFile(join(dir, 'spend.json'), '{broken');
    const ledger = new Ledger(dir);
    await expect(ledger.read()).rejects.toBeInstanceOf(LedgerError);
    await expect(ledger.reserve(50_000n, 1_000_000n)).rejects.toBeInstanceOf(LedgerError);
    expect(await readFile(join(dir, 'spend.json'), 'utf8')).toBe('{broken');
  });

  it('fails the reservation when the folder cannot be written', async () => {
    const dir = await home();
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    const ledger = new Ledger(join(blocker, 'sub'));
    await expect(ledger.reserve(50_000n, 1_000_000n)).rejects.toThrow();
  });
});
