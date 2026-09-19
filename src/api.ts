// Free reads from the D20DAO agent API, and the resend of an already signed payment.

export type Fetch = typeof fetch;

export interface ApiResult {
  status: string;
  stage?: string;
  message?: string;
  paymentId?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  [key: string]: unknown;
}

/** Statuses after which a paid call will not change. `expired` and `refunded` are not final: a replacement follows. */
export const FINAL = new Set(['fulfilled', 'rejected', 'refund_due']);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function readJson(res: Response, url: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`unexpected answer from ${url} (HTTP ${res.status})`, res.status);
  }
}

async function getJson(fetchImpl: Fetch, url: string): Promise<ApiResult> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  const body = await readJson(res, url);
  if (!res.ok) throw new ApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code);
  return body as ApiResult;
}

export const PAYMENT_ID = /^0x[0-9a-fA-F]{64}$/;
export const REQUEST_ID = /^[0-9]{1,78}$/;

export function getPayment(fetchImpl: Fetch, apiBase: string, paymentId: string): Promise<ApiResult> {
  if (!PAYMENT_ID.test(paymentId)) throw new ApiError('paymentId must be 0x followed by 64 hex characters', 400);
  return getJson(fetchImpl, `${apiBase}/v1/payments/${paymentId}`);
}

export function getRequest(fetchImpl: Fetch, apiBase: string, requestId: string): Promise<ApiResult> {
  if (!REQUEST_ID.test(requestId)) throw new ApiError('requestId must be a decimal number', 400);
  return getJson(fetchImpl, `${apiBase}/v1/random/${requestId}`);
}

/**
 * Sends an already signed payment again with the same body. The API answers a payment it has seen
 * with that same call, and settles one it has not seen exactly once.
 */
export async function resendPayment(
  fetchImpl: Fetch,
  apiBase: string,
  body: string,
  paymentHeader: string,
): Promise<{ httpStatus: number; body: any }> {
  const url = `${apiBase}/v1/random`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'payment-signature': paymentHeader },
    body,
    signal: AbortSignal.timeout(40_000),
  });
  return { httpStatus: res.status, body: await readJson(res, url) };
}

/**
 * Follows a paid call through the free status route until it is final or the time is up.
 * It never pays: a pending call is finished by reading, not by paying again.
 */
export async function waitForResult(
  fetchImpl: Fetch,
  apiBase: string,
  first: ApiResult,
  paymentId: string,
  options: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ApiResult> {
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const until = now() + (options.timeoutMs ?? 15_000);
  let current = first;
  while (!FINAL.has(current.status) && now() < until) {
    const hint = Number(current.retryAfterSeconds);
    const wait = Math.min(Math.max(Number.isFinite(hint) ? hint : 3, 2), 5) * 1000;
    await sleep(Math.min(wait, Math.max(until - now(), 0)));
    try {
      current = await getPayment(fetchImpl, apiBase, paymentId);
    } catch {
      // A failed read keeps the last known state; the loop tries again until the deadline.
    }
  }
  return current;
}
