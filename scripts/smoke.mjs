// Starts the built server over stdio, lists its tools and calls one tool (default: the free setup_status).
// The spending record goes to a temporary folder unless D20_MCP_HOME is set. `draw` with valid input pays.
// Usage: node scripts/smoke.mjs [tool] [json-args]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [tool = 'setup_status', rawArgs = '{}'] = process.argv.slice(2);
const env = { ...process.env, D20_MCP_HOME: process.env.D20_MCP_HOME ?? mkdtempSync(join(tmpdir(), 'd20-smoke-')) };
const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'], env });
const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  }
});
let nextId = 1;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const init = await call('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
console.log('server:', JSON.stringify(init.result?.serverInfo), 'protocol:', init.result?.protocolVersion);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = await call('tools/list', {});
for (const t of tools.result.tools) console.log('tool:', t.name, '|', t.title, '|', JSON.stringify(t.annotations));
const result = await call('tools/call', { name: tool, arguments: JSON.parse(rawArgs) });
console.log(JSON.stringify(result.result ?? result.error, null, 2));
child.kill();
