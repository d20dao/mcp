#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createCircleRunner, findCircleCli, verifyCircleCli } from './circle.js';
import { loadConfig, type Config } from './config.js';
import { Ledger } from './ledger.js';
import { createServer } from './server.js';
import { D20Service, type CliHandle } from './service.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  process.stderr.write(`d20dao-mcp: bad settings: ${(error as Error).message}\n`);
  process.exit(1);
}

let cached: CliHandle | undefined;
function cli(): CliHandle | { error: string } {
  if (cached) return cached;
  const entry = findCircleCli(config.circleCli);
  if (!entry) return { error: config.circleCli ? `D20_CIRCLE_CLI points to ${config.circleCli}, which does not exist.` : 'The Circle CLI is not installed.' };
  const checked = verifyCircleCli(entry);
  if ('error' in checked) return checked;
  cached = { run: createCircleRunner(entry), path: checked.path, version: checked.version };
  return cached;
}

const service = new D20Service({ config, cli, ledger: new Ledger(config.home) });

serveStdio(() => createServer(service), {
  onerror: (error) => process.stderr.write(`d20dao-mcp: ${error.message}\n`),
});
