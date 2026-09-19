import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliError, failedBeforePayment, findCircleCli, verifyCircleCli, type CliResult } from '../src/circle.js';

const err = (code: string, message: string, hint?: string, exit: number | null = 1): CliResult => {
  const error = hint ? { code, message, hint } : { code, message };
  return { code: exit, stdout: JSON.stringify({ error }), stderr: '', json: { error } };
};

async function fakeCli(name = '@circle-fin/cli', version = '1.1.3') {
  const prefix = await mkdtemp(join(tmpdir(), 'd20-cli-'));
  const pkg = join(prefix, 'node_modules', '@circle-fin', 'cli');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version }));
  await writeFile(join(pkg, 'dist', 'index.js'), '');
  await writeFile(join(prefix, 'circle.cmd'), '');
  return { prefix, entry: join(pkg, 'dist', 'index.js') };
}

describe('failedBeforePayment', () => {
  it('accepts only the CLI signals that come before signing', () => {
    expect(failedBeforePayment(err('INVALID_ARGUMENT', 'Insufficient Gateway balance for $0.05 payment.'))).toBe(true);
    expect(failedBeforePayment(err('AUTH_REQUIRED', 'Not logged in (or session expired).'))).toBe(true);
    expect(failedBeforePayment(err('PERMISSION_DENIED', 'Circle CLI Terms acceptance is required before use.'))).toBe(true);
    expect(failedBeforePayment(err('INTERNAL', 'Could not reach the endpoint.', 'No funds were moved - error occurred before payment authorization.'))).toBe(true);
  });

  it('treats everything else as possibly paid', () => {
    expect(failedBeforePayment(err('INTERNAL', 'Payment submitted but paid request failed.', 'PAYMENT MAY HAVE BEEN SUBMITTED'))).toBe(false);
    expect(failedBeforePayment(err('TIMEOUT', 'The operation was aborted'))).toBe(false);
    expect(failedBeforePayment({ ...err('INVALID_ARGUMENT', 'x'), code: null, killed: true })).toBe(false);
    expect(failedBeforePayment({ code: 1, stdout: 'garbage', stderr: 'boom' })).toBe(false);
  });
});

describe('cliError', () => {
  it('drops the advice to accept terms by environment variable', () => {
    const text = cliError(err('PERMISSION_DENIED', 'Circle CLI Terms acceptance is required before use.', 'Set CIRCLE_ACCEPT_TERMS=1 to accept in non-interactive shells (CI, scripts, sandboxed agents).'));
    expect(text).toBe('Circle CLI Terms acceptance is required before use.');
  });
});

describe('findCircleCli', () => {
  it('finds the CLI next to a circle shim on an absolute PATH entry', async () => {
    const { prefix, entry } = await fakeCli();
    if (process.platform === 'win32') expect(findCircleCli(undefined, { PATH: prefix })).toBe(entry);
  });

  it('ignores relative PATH entries', async () => {
    expect(findCircleCli(undefined, { PATH: ['node_modules/.bin', '.'].join(process.platform === 'win32' ? ';' : ':') })).toBeUndefined();
  });

  it('honours an explicit path only if it exists', async () => {
    const { entry } = await fakeCli();
    expect(findCircleCli(entry, { PATH: '' })).toBe(entry);
    expect(findCircleCli(entry + '.missing', { PATH: '' })).toBeUndefined();
  });
});

describe('verifyCircleCli', () => {
  it('accepts @circle-fin/cli 1.x from 1.1.3', async () => {
    expect(verifyCircleCli((await fakeCli()).entry)).toMatchObject({ version: '1.1.3' });
    expect(verifyCircleCli((await fakeCli('@circle-fin/cli', '1.4.0')).entry)).toMatchObject({ version: '1.4.0' });
  });

  it('rejects other packages and untested versions', async () => {
    expect(verifyCircleCli((await fakeCli('evil-cli')).entry)).toHaveProperty('error');
    expect(verifyCircleCli((await fakeCli('@circle-fin/cli', '1.1.2')).entry)).toHaveProperty('error');
    expect(verifyCircleCli((await fakeCli('@circle-fin/cli', '2.0.0')).entry)).toHaveProperty('error');
  });
});
