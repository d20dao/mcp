// Builds the POST /v1/random body and checks it with the API's own rules before anything is paid.
// The API answers the unpaid call with 402 without reading the body, so a bad body would only
// surface after the CLI has signed a payment; catching it here keeps that from happening.

export const OPERATIONS = ['raw', 'coinFlip', 'dice', 'range', 'chooseOne', 'chooseMany', 'shuffle'] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface DrawInput {
  operation: Operation;
  sides?: number | string;
  count?: number;
  min?: number | string;
  max?: number | string;
  population?: number;
  items?: string[];
  seed?: string;
}

export type DrawBody = Record<string, unknown> & { operation: Operation };

export class InputError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_DICE = 128;
const MAX_ITEMS = 256;
const MAX_ITEM_BYTES = 200;
const MAX_SEED_BYTES = 64;
const MAX_BODY_BYTES = 65_536;
const MAX_WINDOWS_ARG = 30_000;

const PARAMS = ['sides', 'count', 'min', 'max', 'population', 'items'] as const;
type Param = (typeof PARAMS)[number];

const FIELDS: Record<Operation, readonly Param[]> = {
  raw: [],
  coinFlip: [],
  dice: ['sides', 'count'],
  range: ['min', 'max'],
  chooseOne: ['population', 'items'],
  chooseMany: ['population', 'items', 'count'],
  shuffle: ['population', 'items'],
};

const utf8 = new TextEncoder();

function uint(value: number | string, field: string): bigint {
  let parsed: bigint | undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) parsed = BigInt(value);
  if (parsed === undefined || parsed > MAX_UINT256) {
    throw new InputError(`${field} must be a non-negative integer (a number, or a decimal string above 2^53)`, field);
  }
  return parsed;
}

function smallInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${field} must be an integer from ${min} to ${max}`, field);
  }
  return value;
}

function population(input: DrawInput): number {
  const hasPopulation = input.population !== undefined;
  const hasItems = input.items !== undefined;
  if (hasPopulation === hasItems) throw new InputError('give exactly one of population or items', 'population');
  if (hasPopulation) return smallInt(input.population, 'population', 1, MAX_ITEMS);
  const items = input.items!;
  if (items.length < 1 || items.length > MAX_ITEMS) throw new InputError(`items must hold 1 to ${MAX_ITEMS} strings`, 'items');
  for (const item of items) {
    if (utf8.encode(item).length > MAX_ITEM_BYTES) throw new InputError(`each item must be at most ${MAX_ITEM_BYTES} bytes`, 'items');
  }
  return items.length;
}

/** Validates a draw and returns the exact body to send: operation, its own fields and seed, nothing else. */
export function buildDrawBody(input: DrawInput): DrawBody {
  const op = input.operation;
  for (const key of Object.keys(input)) {
    if (key !== 'operation' && key !== 'seed' && !(PARAMS as readonly string[]).includes(key)) {
      throw new InputError(`unknown field ${key}; the API rejects anything but operation, seed and the operation's own fields`, key);
    }
  }
  if (!(OPERATIONS as readonly string[]).includes(op)) {
    throw new InputError(`operation must be one of ${OPERATIONS.join(', ')}`, 'operation');
  }
  const allowed = FIELDS[op];
  for (const field of PARAMS) {
    if (input[field] !== undefined && !allowed.includes(field)) {
      const takes = allowed.length ? allowed.join(', ') : 'no parameters';
      throw new InputError(`${op} does not take ${field} (it takes ${takes}, plus seed)`, field);
    }
  }
  if (input.seed !== undefined && utf8.encode(input.seed).length > MAX_SEED_BYTES) {
    throw new InputError(`seed must be at most ${MAX_SEED_BYTES} bytes of UTF-8`, 'seed');
  }

  switch (op) {
    case 'dice': {
      if (input.sides === undefined) throw new InputError('dice needs sides', 'sides');
      if (uint(input.sides, 'sides') < 2n) throw new InputError('sides must be at least 2', 'sides');
      if (input.count !== undefined) smallInt(input.count, 'count', 1, MAX_DICE);
      break;
    }
    case 'range': {
      if (input.min === undefined || input.max === undefined) {
        throw new InputError('range needs min and max', input.min === undefined ? 'min' : 'max');
      }
      if (uint(input.min, 'min') > uint(input.max, 'max')) throw new InputError('min must not exceed max', 'min');
      break;
    }
    case 'chooseOne':
    case 'shuffle':
      population(input);
      break;
    case 'chooseMany': {
      const n = population(input);
      if (input.count === undefined) throw new InputError('chooseMany needs count', 'count');
      smallInt(input.count, 'count', 1, n);
      break;
    }
  }

  const body: DrawBody = { operation: op };
  for (const field of allowed) if (input[field] !== undefined) body[field] = input[field];
  if (input.seed !== undefined && input.seed !== '') body.seed = input.seed;
  checkSize(JSON.stringify(body));
  return body;
}

/** The API refuses bodies over 64 KiB, and Windows caps a command line near 32K characters. */
export function checkSize(json: string, platform: NodeJS.Platform = process.platform): void {
  if (utf8.encode(json).length > MAX_BODY_BYTES) throw new InputError('the request is too large; use population or shorter items', 'items');
  if (platform === 'win32') {
    // Upper bound of the quoted argument: every quote and backslash may gain an escaping backslash.
    const quoted = json.length + (json.match(/["\\]/g)?.length ?? 0) + 2;
    if (quoted > MAX_WINDOWS_ARG) throw new InputError('the request is too large to hand to the Circle CLI on Windows; use population or shorter items', 'items');
  }
}
