// Runs the user's Circle CLI (@circle-fin/cli). The CLI holds the agent wallet session; this server
// never sees a key. The CLI's entry script is run with this process's Node, without a shell, so JSON
// bodies reach it unchanged on every platform.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const CLI_ENTRY = join('node_modules', '@circle-fin', 'cli', 'dist', 'index.js');

/** The CLI versions whose output and error texts this server was checked against. */
export const TESTED_CLI = { major: 1, minMinor: 1, minPatch: 3 };

export interface CliResult {
  /** The exit code, or null when the process was killed or ended by a signal. */
  code: number | null;
  killed?: boolean;
  stdout: string;
  stderr: string;
  /** The parsed `--output json` document: `{ data }` on success, `{ error }` on failure. */
  json?: { data?: any; error?: { code?: string; message?: string; hint?: string } };
}

export type CircleRunner = (args: string[], timeoutMs?: number) => Promise<CliResult>;

export interface CircleCli {
  path: string;
  version: string;
}

/** Reads the package.json above a CLI entry script and checks it is a supported @circle-fin/cli. */
export function verifyCircleCli(entry: string): CircleCli | { error: string } {
  let pkg: { name?: string; version?: string };
  try {
    pkg = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'));
  } catch {
    return { error: `${entry} is not inside an @circle-fin/cli package` };
  }
  if (pkg.name !== '@circle-fin/cli') return { error: `${entry} belongs to ${pkg.name ?? 'an unknown package'}, not @circle-fin/cli` };
  const [major = 0, minor = 0, patch = 0] = (pkg.version ?? '').split('.').map((n) => Number.parseInt(n, 10));
  const { major: M, minMinor, minPatch } = TESTED_CLI;
  if (major !== M || minor < minMinor || (minor === minMinor && patch < minPatch)) {
    return { error: `Circle CLI ${pkg.version} is not supported; install 1.x from ${M}.${minMinor}.${minPatch} (npm install -g @circle-fin/cli@1)` };
  }
  return { path: entry, version: pkg.version! };
}

/** Finds the CLI's entry script: an explicit path, then `circle` on PATH (absolute entries only), then the usual global folders. */
export function findCircleCli(override?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (override) return existsSync(override) ? override : undefined;
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d && isAbsolute(d));
  for (const dir of dirs) {
    if (process.platform === 'win32') {
      if (existsSync(join(dir, 'circle.cmd')) && existsSync(join(dir, CLI_ENTRY))) return join(dir, CLI_ENTRY);
    } else {
      const bin = join(dir, 'circle');
      if (existsSync(bin)) {
        const target = realpathSync(bin);
        if (target.endsWith('.js')) return target;
      }
    }
  }
  const fallbacks =
    process.platform === 'win32'
      ? [env.APPDATA && join(env.APPDATA, 'npm'), env.ProgramFiles && join(env.ProgramFiles, 'nodejs')]
      : ['/usr/local/lib', '/opt/homebrew/lib', '/usr/lib', env.HOME && join(env.HOME, '.npm-global', 'lib')];
  for (const dir of fallbacks) {
    if (dir && existsSync(join(dir, CLI_ENTRY))) return join(dir, CLI_ENTRY);
  }
  return undefined;
}

export function createCircleRunner(entry: string): CircleRunner {
  // CIRCLE_ACCEPT_TERMS would let the CLI accept Circle's terms for the user; accepting them is theirs
  // to do. Windows environment names are case-insensitive, so every spelling goes.
  // DO_NOT_TRACK keeps the draw's own arguments, which can hold the user's item labels, out of the
  // CLI's telemetry.
  const env: NodeJS.ProcessEnv = { ...process.env, DO_NOT_TRACK: process.env.DO_NOT_TRACK ?? '1' };
  for (const name of Object.keys(env)) if (/^circle_accept_terms$/i.test(name)) delete env[name];
  return (args, timeoutMs = 60_000) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [entry, ...args],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env },
        (error, stdout, stderr) => {
          const killed = Boolean(error && (error.killed || error.signal));
          const code = !error ? 0 : typeof error.code === 'number' && !killed ? error.code : null;
          let json: CliResult['json'];
          try {
            json = JSON.parse(stdout);
          } catch {
            json = undefined;
          }
          resolve({ code, killed, stdout, stderr, json });
        },
      );
    });
}

/** Where the CLI saves a signed payment when the paid request fails. */
export function paymentLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CIRCLE_CLI_HOME ?? join(homedir(), '.circle-cli'), 'payments');
}

export async function listPaymentLogs(dir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(dir)).filter((name) => /^payment-.*\.json$/.test(name)));
  } catch {
    return new Set();
  }
}

/** The CLI's error message, without advice this server must not pass on (such as accepting terms by env var). */
export function cliError(result: CliResult): string {
  const clean = (text: string) =>
    text
      .split('\n')
      .filter((line) => !/CIRCLE_ACCEPT_TERMS/.test(line))
      .join('\n')
      .trim();
  const error = result.json?.error;
  if (error?.message) return [clean(error.message), clean(error.hint ?? '')].filter(Boolean).join(' ');
  return (
    clean(result.stderr) ||
    clean(result.stdout) ||
    (result.killed ? 'the Circle CLI was stopped before it finished' : `Circle CLI exited with code ${result.code}`)
  );
}

/**
 * True only for failures the CLI reports before it signs anything. Everything else, including a
 * killed process or unreadable output, may have paid and is treated as unknown.
 */
export function failedBeforePayment(result: CliResult): boolean {
  if (result.killed || result.code === null || result.code === 0) return false;
  const error = result.json?.error;
  if (!error) return false;
  if (['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'NOT_FOUND', 'PERMISSION_DENIED', 'VERSION_BLOCKED'].includes(error.code ?? '')) return true;
  if (/No funds were moved/.test(error.hint ?? '')) return true;
  return /^Could not resolve backing EOA/.test(error.message ?? '');
}
