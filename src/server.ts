import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PRICE_USDC } from './config.js';
import { OPERATIONS } from './request.js';
import type { D20Service, Outcome } from './service.js';

export const VERSION: string = createRequire(import.meta.url)('../package.json').version;

const INSTRUCTIONS = [
  'D20DAO sells verifiable random results. Each draw opens one VRF request on Arc and returns the proven result with links anyone can check.',
  `A draw costs ${PRICE_USDC} USDC, paid from the user's Circle Agent Wallet through the Circle CLI.`,
  'Ask for every value you need in one draw: up to 128 dice, several winners or a whole shuffle.',
  'Give each separate draw its own seed, such as "round 3"; an identical draw repeated within five minutes returns the earlier one instead of paying again.',
  'Never draw again to change a result you do not like. A pending or unanswered draw is finished with get_result, for free; when charged is "unknown", do not draw again for it.',
  'If draw reports missing setup or funds, call setup_status and follow its next step. Logging in, accepting Circle terms and funding the wallet are for the user to do and approve.',
].join(' ');

const uint = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^(0|[1-9][0-9]{0,77})$/, 'a decimal string'),
]);

const drawInput = z.strictObject({
  operation: z
    .enum(OPERATIONS)
    .describe(
      'raw: one 256-bit word. coinFlip: 0 (tails) or 1 (heads). dice: count rolls of 1 to sides. range: one integer from min to max. ' +
        'chooseOne: one zero-based index. chooseMany: count distinct indices. shuffle: every index once.',
    ),
  sides: uint.optional().describe('dice only, required: faces per die, at least 2.'),
  count: z.number().int().min(1).max(256).optional().describe('dice: rolls, 1 to 128 (default 1). chooseMany: distinct picks, required.'),
  min: uint.optional().describe('range only, required: lowest value, inclusive.'),
  max: uint.optional().describe('range only, required: highest value, inclusive, at least min.'),
  population: z.number().int().min(1).max(256).optional().describe('chooseOne, chooseMany, shuffle: how many to draw from, 1 to 256. Give this or items.'),
  items: z
    .array(z.string().max(200))
    .min(1)
    .max(256)
    .optional()
    .describe('chooseOne, chooseMany, shuffle: labels to draw from (1 to 256, each at most 200 bytes). Only their count is proven; the answer adds picked. Give this or population.'),
  seed: z
    .string()
    .max(64)
    .optional()
    .describe('Context bound on chain to this draw, such as "raffle-7 round 2" (at most 64 bytes). Use a new seed for each separate draw. To commit to an item list, put its hash here.'),
});

const resultInput = z.strictObject({
  paymentId: z.string().max(66).optional().describe('The paymentId of a paid draw (0x and 64 hex characters).'),
  requestId: z.string().max(78).optional().describe('A request id this API opened, as a decimal string.'),
});

function toolResult(outcome: Outcome) {
  const text = JSON.stringify(outcome.data, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: outcome.data,
    isError: !outcome.ok,
  };
}

export function createServer(service: D20Service): McpServer {
  const server = new McpServer({ name: 'd20dao', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.registerTool(
    'draw',
    {
      title: `Draw verifiable randomness (${PRICE_USDC} USDC)`,
      description:
        `Draw verifiable randomness for ${PRICE_USDC} USDC: dice, a coin flip, a number in a range, one or several winners, or a shuffle. ` +
        'Opens one VRF request on Arc and returns the result with request, fulfillment and proof links; the optional seed is bound to the payment on chain. ' +
        "Pays from the user's Circle Agent Wallet. One call returns every value of its operation, so ask once and never repeat a call to re-roll. " +
        'An identical call within five minutes returns the earlier draw without paying; give each separate draw its own seed. ' +
        'The user sets a daily spending cap, so draws can run out: a paid answer carries what is left, and setup_status shows the cap.',
      inputSchema: drawInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => toolResult(await service.draw(input)),
  );

  server.registerTool(
    'get_result',
    {
      title: 'Read a draw (free)',
      description:
        'Read a paid draw by paymentId, or a request by requestId, for free. Use it to finish a draw that came back pending or unanswered. ' +
        'Chosen items come back as indices here, not as labels: apply them to the list you sent.',
      inputSchema: resultInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => toolResult(await service.getResult(input)),
  );

  server.registerTool(
    'setup_status',
    {
      title: 'Check payment setup (free)',
      description:
        "Check whether draws can be paid: the Circle CLI, its login, the agent wallet, its Gateway balance and today's spending. Returns the next setup step.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => toolResult(await service.setupStatus()),
  );

  return server;
}
