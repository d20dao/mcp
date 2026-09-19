// The work behind the tools: setup checks, paying for a draw through the Circle CLI, and free reads.
//
// Money rules:
// - The price is reserved in the shared ledger before the CLI runs; no reservation, no payment.
// - A draw is reported as not charged only when that is known: the CLI failed before signing, the
//   API refused the payment, or the call was rejected. Everything else is "unknown" and the agent
//   is told not to draw again.
// - A pending call is finished by free reads, a lost answer by resending the same signed payment,
//   and an identical draw within a short window returns the earlier one. Nothing here pays twice.
import { ApiError, FINAL, PAYMENT_ID, getPayment, getRequest, resendPayment, waitForResult, type ApiResult, type Fetch } from './api.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliError, failedBeforePayment, listPaymentLogs, paymentLogDir, type CircleRunner, type CliResult } from './circle.js';
import {
  CLI_HTTP_TIMEOUT_S,
  CLI_PROCESS_TIMEOUT_MS,
  CLI_READ_TIMEOUT_MS,
  FUND_URL,
  PAY_CHAINS,
  POLL_MS,
  PRICE_ATOMIC,
  PRICE_USDC,
  REPEAT_WINDOW_MS,
  SELLER,
  SETUP_URL,
  formatUsdc,
  type Config,
} from './config.js';
import type { Ledger, Reservation } from './ledger.js';
import { scanNewPaymentLogs, type PaymentLogMatch, type SavedPayment } from './recovery.js';
import { buildDrawBody, InputError, type DrawInput } from './request.js';

export interface Outcome {
  ok: boolean;
  data: Record<string, unknown>;
}

export interface CliHandle {
  run: CircleRunner;
  path: string;
  version: string;
}

export interface ServiceDeps {
  config: Config;
  /** Finds the Circle CLI on each use, so installing it later needs no restart. */
  cli: () => CliHandle | { error: string };
  ledger: Ledger;
  fetch?: Fetch;
  /** The CLI's payments folder, where it saves a signed payment whose request failed. */
  paymentLogDir?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class SetupError extends Error {}

const DO_NOT_REPEAT = 'Do not draw again for this.';

function toAtomic(value: string): bigint {
  const [whole = '0', fraction = ''] = String(value).trim().split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0') || '0');
}

const notCharged = (error: string, extra: Record<string, unknown> = {}): Outcome => ({ ok: false, data: { error, charged: false, ...extra } });

function unknown(detail: string, paymentId?: string): Outcome {
  return {
    ok: false,
    data: {
      error: 'The payment may have gone through, but no answer came back.',
      charged: 'unknown',
      paymentId,
      next: paymentId
        ? `Call get_result with this paymentId. ${DO_NOT_REPEAT}`
        : `${DO_NOT_REPEAT} The user can check the wallet with circle gateway balance.`,
      // The CLI's message can quote the API's answer, so it is untrusted text, kept short.
      detail: detail.length > 300 ? `${detail.slice(0, 300)}…` : detail,
    },
  };
}

export class D20Service {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly logDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<Outcome>>();
  private readonly recent = new Map<string, { at: number; outcome: Outcome }>();
  private halted?: string;

  constructor(private readonly deps: ServiceDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.logDir = deps.paymentLogDir ?? paymentLogDir();
  }

  private get config() {
    return this.deps.config;
  }

  private get chains() {
    return PAY_CHAINS[this.config.network];
  }

  /** Paid draws in one process run one at a time; the shared ledger keeps the cap across processes. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private fundingStep(address?: string): string {
    const chain = this.chains[0]!.chain;
    const faucet = this.config.network === 'testnet' ? ' Testnet USDC is free at https://faucet.circle.com.' : '';
    return (
      `Ask the owner to fund the agent wallet with USDC (${FUND_URL}), then deposit it into Circle Gateway: ` +
      `circle gateway deposit --chain ${chain} --method direct --amount 1 --address ${address ?? '<wallet>'}. ` +
      `On Arc the deposit pays its own gas in USDC. Each draw costs ${PRICE_USDC} USDC.${faucet}`
    );
  }

  private setupHint(message: string): string {
    if (/terms/i.test(message)) {
      return `The user has to accept Circle's terms themselves before the CLI works (${SETUP_URL}, step 3). Do not accept them on the user's behalf.`;
    }
    if (/not logged in|session expired/i.test(message)) {
      const testnet = this.config.network === 'testnet' ? ' --testnet' : '';
      return `The Circle CLI is not logged in: the user runs circle wallet login <email>${testnet} and enters the emailed code (${SETUP_URL}).`;
    }
    if (/insufficient gateway balance|no gateway balance/i.test(message)) return `${message} ${this.fundingStep()}`;
    return message;
  }

  private async wallet(run: CircleRunner): Promise<string> {
    if (this.config.walletAddress) return this.config.walletAddress;
    const result = await run(['wallet', 'list', '--chain', this.chains[0]!.chain, '--type', 'agent', '--output', 'json'], CLI_READ_TIMEOUT_MS);
    if (result.code !== 0) throw new SetupError(this.setupHint(cliError(result)));
    const address = result.json?.data?.wallets?.[0]?.address;
    if (typeof address !== 'string') throw new SetupError(`No Circle agent wallet yet: run circle wallet create (see ${SETUP_URL}).`);
    return address;
  }

  private async balances(run: CircleRunner, address: string): Promise<{ chain: string; balanceAtomic: bigint }[]> {
    const args = ['gateway', 'balance', '--address', address, '--chain', this.chains[0]!.chain, '--all', '--output', 'json'];
    const result = await run(args, CLI_READ_TIMEOUT_MS);
    if (result.code !== 0) throw new SetupError(this.setupHint(cliError(result)));
    const rows: { domain: number; balance: string }[] = result.json?.data?.balances ?? [];
    return this.chains.map(({ chain, domain }) => {
      const row = rows.find((r) => r.domain === domain);
      return { chain, balanceAtomic: row ? toAtomic(row.balance) : 0n };
    });
  }

  /** The chain to pay from: the configured one if it holds the price, otherwise the first that does. */
  private async payChain(run: CircleRunner, address: string): Promise<string> {
    const balances = await this.balances(run, address);
    const chosen = this.config.payChain
      ? balances.find((b) => b.chain === this.config.payChain && b.balanceAtomic >= PRICE_ATOMIC)
      : balances.find((b) => b.balanceAtomic >= PRICE_ATOMIC);
    if (!chosen) {
      const where = this.config.payChain ? `on ${this.config.payChain} (D20_PAY_CHAIN)` : 'on every chain';
      throw new SetupError(`The Gateway balance is below ${PRICE_USDC} USDC ${where}. ${this.fundingStep(address)}`);
    }
    return chosen.chain;
  }

  /** What the daily cap still allows, for the agent to plan with; unknown if the record cannot be read. */
  private async leftToday(): Promise<string> {
    try {
      const { spentAtomic } = await this.deps.ledger.read();
      const left = this.config.dailyLimitAtomic - spentAtomic;
      return `${formatUsdc(left > 0n ? left : 0n)} USDC`;
    } catch {
      return 'unknown';
    }
  }

  private get haltFile(): string {
    return join(this.config.home, 'halt.json');
  }

  /** A seller mismatch stops paid draws, so it has to outlive the process. Returns what to tell the user. */
  private async halt(reason: string): Promise<string> {
    this.halted = reason;
    try {
      await mkdir(this.config.home, { recursive: true });
      await writeFile(this.haltFile, JSON.stringify({ reason }) + '\n', { mode: 0o600 });
      return `${reason} Paid draws are stopped until the user deletes ${this.haltFile}.`;
    } catch (error) {
      return `${reason} This server could not record the stop in ${this.haltFile} (${(error as Error).message}), so only this process refuses further draws: tell the user to stop it.`;
    }
  }

  /** The recorded stop, re-read each time so deleting the file takes effect without a restart. */
  private async haltReason(): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(this.haltFile, 'utf8');
    } catch (error) {
      // Only a missing file means no stop; an unreadable one keeps draws stopped.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.halted = undefined);
      return (this.halted = `Paid draws are stopped: ${this.haltFile} cannot be read (${(error as Error).message}). The user decides whether to delete it.`);
    }
    try {
      const { reason } = JSON.parse(text);
      if (typeof reason !== 'string') throw new Error('no reason');
      return (this.halted = reason);
    } catch {
      return (this.halted = `Paid draws are stopped: ${this.haltFile} is damaged, so an earlier stop cannot be read. The user decides whether to delete it.`);
    }
  }

  private async release(reservation: Reservation): Promise<void> {
    // Failing to give a reservation back only over-counts, which is the safe direction.
    await this.deps.ledger.release(reservation).catch(() => undefined);
  }

  async setupStatus(): Promise<Outcome> {
    const data: Record<string, unknown> = {
      network: this.config.network,
      price: `${PRICE_USDC} USDC per draw`,
      dailyLimit: `${formatUsdc(this.config.dailyLimitAtomic)} USDC`,
      ready: false,
    };
    try {
      const { spentAtomic, draws } = await this.deps.ledger.read();
      data.spentToday = `${formatUsdc(spentAtomic)} USDC in ${draws} draws`;
      if (spentAtomic + PRICE_ATOMIC > this.config.dailyLimitAtomic) {
        data.nextStep = 'The daily limit is reached. The user can raise D20_DAILY_LIMIT_USDC in the server settings.';
      }
    } catch (error) {
      data.nextStep = `Paid draws are paused: ${(error as Error).message}`;
    }
    const halted = await this.haltReason();
    if (halted) data.nextStep = halted;
    if (process.env.CIRCLE_PROXY_URL) data.warning = `CIRCLE_PROXY_URL is set to ${process.env.CIRCLE_PROXY_URL}, so the Circle CLI does not talk to Circle directly. Tell the user.`;

    const cli = this.deps.cli();
    if ('error' in cli) {
      data.nextStep = `${cli.error} Install and set up the Circle CLI (npm install -g @circle-fin/cli@1), following ${SETUP_URL}.`;
      return { ok: true, data };
    }
    data.circleCli = { path: cli.path, version: cli.version };

    const status = await cli.run(['wallet', 'status', '--output', 'json']);
    if (status.code !== 0) {
      data.nextStep = this.setupHint(cliError(status));
      return { ok: true, data };
    }
    const login = status.json?.data?.[this.config.network]?.tokenStatus;
    data.login = login;
    if (login !== 'VALID') {
      data.nextStep = this.setupHint('not logged in');
      return { ok: true, data };
    }
    try {
      const address = await this.wallet(cli.run);
      data.wallet = address;
      const balances = await this.balances(cli.run, address);
      data.gatewayBalances = Object.fromEntries(balances.map((b) => [b.chain, formatUsdc(b.balanceAtomic)]));
      const funded = balances.filter((b) => b.balanceAtomic >= PRICE_ATOMIC);
      const chain = (this.config.payChain ? funded.find((b) => b.chain === this.config.payChain) : funded[0])?.chain;
      if (!chain) {
        const where = this.config.payChain ? `on ${this.config.payChain} (D20_PAY_CHAIN)` : 'on every chain';
        data.nextStep ??= `The Gateway balance is below ${PRICE_USDC} USDC ${where}. ${this.fundingStep(address)}`;
        return { ok: true, data };
      }
      data.payChain = chain;
    } catch (error) {
      data.nextStep ??= (error as Error).message;
      return { ok: true, data };
    }
    if (data.nextStep === undefined) {
      data.ready = true;
      data.nextStep = 'Ready: call draw.';
    }
    return { ok: true, data };
  }

  draw(input: DrawInput): Promise<Outcome> {
    let body: Record<string, unknown>;
    try {
      body = buildDrawBody(input);
    } catch (error) {
      if (error instanceof InputError) return Promise.resolve(notCharged(error.message, { field: error.field }));
      throw error;
    }
    const key = JSON.stringify(body);
    const running = this.inflight.get(key);
    if (running) return running.then(asRepeat);
    const earlier = this.recent.get(key);
    if (earlier && this.now() - earlier.at < REPEAT_WINDOW_MS) return Promise.resolve(asRepeat(earlier.outcome));

    const run = this.serial(() => this.pay(body, key)).then((outcome) => {
      if (outcome.data.charged !== false) this.remember(key, outcome);
      return outcome;
    });
    this.inflight.set(key, run);
    const done = () => this.inflight.delete(key);
    run.then(done, done);
    return run;
  }

  private remember(key: string, outcome: Outcome): void {
    const now = this.now();
    for (const [k, v] of this.recent) if (now - v.at >= REPEAT_WINDOW_MS) this.recent.delete(k);
    this.recent.set(key, { at: now, outcome });
  }

  private async pay(body: Record<string, unknown>, json: string): Promise<Outcome> {
    const halted = await this.haltReason();
    if (halted) return notCharged(halted);
    const cli = this.deps.cli();
    if ('error' in cli) return notCharged(`${cli.error} Set up the Circle CLI with ${SETUP_URL}, then call setup_status.`);

    let address: string;
    let chain: string;
    try {
      address = await this.wallet(cli.run);
      chain = await this.payChain(cli.run, address);
    } catch (error) {
      return notCharged(error instanceof SetupError ? error.message : `Could not check the wallet: ${(error as Error).message}`);
    }

    let reservation: Reservation;
    try {
      const reserved = await this.deps.ledger.reserve(PRICE_ATOMIC, this.config.dailyLimitAtomic);
      if ('refusedAt' in reserved) {
        return notCharged(
          `Daily limit reached: ${formatUsdc(reserved.refusedAt)} of ${formatUsdc(this.config.dailyLimitAtomic)} USDC spent today. ` +
            'The user can raise D20_DAILY_LIMIT_USDC in the server settings.',
        );
      }
      reservation = reserved;
    } catch (error) {
      return notCharged(`Paid draws are paused: ${(error as Error).message}`);
    }

    const url = `${this.config.apiBase}/v1/random`;
    const paid = { amount: `${PRICE_USDC} USDC`, chain };
    try {
      const before = await listPaymentLogs(this.logDir);
      // Wall-clock times, because they bracket the timestamp the CLI writes into its log.
      const startedAt = Date.now();
      const args = [
        'services', 'pay', url, '-X', 'POST', '-d', json,
        '--address', address, '--chain', chain,
        '--max-amount', PRICE_USDC, '--timeout', String(CLI_HTTP_TIMEOUT_S), '--output', 'json',
      ];
      const result = await cli.run(args, CLI_PROCESS_TIMEOUT_MS);
      const expect: PaymentLogMatch = { url, address, blockchain: chain, amountUsdc: PRICE_USDC, since: startedAt, until: Date.now() };
      return await this.settle(result, before, reservation, body, json, expect, paid);
    } catch (error) {
      return unknown((error as Error).message);
    }
  }

  private async settle(
    result: CliResult,
    before: Set<string>,
    reservation: Reservation,
    body: Record<string, unknown>,
    json: string,
    expect: PaymentLogMatch,
    paid: Record<string, unknown>,
  ): Promise<Outcome> {
    const data = result.json?.data;
    const payment = data?.payment;
    if (payment) {
      // The CLI reports a payment, so money moved, whatever the exit code says.
      let warning: string | undefined;
      if (String(payment.seller ?? '').toLowerCase() !== SELLER.toLowerCase()) {
        warning = await this.halt(`This draw paid ${payment.seller}, not the D20DAO seller ${SELLER}. Tell the user at once.`);
      }
      const response = data.response;
      if (response && typeof response === 'object' && typeof response.status === 'string') {
        return this.finish(response as ApiResult, paid, reservation, body, warning);
      }
      return {
        ok: false,
        data: {
          error: 'Paid, but the API answer could not be read. The result may still exist.',
          charged: true,
          paid: { ...paid, settlement: payment.receipt ? 'in the Circle CLI payment receipt' : undefined },
          warning,
          next: `${DO_NOT_REPEAT} The user can look for the draw on ${this.config.apiBase} or in the wallet's Gateway history.`,
        },
      };
    }
    if (result.code === 0 && /\(no payment required\)/.test(String(data?.message ?? ''))) {
      await this.release(reservation);
      return notCharged('The API answered without asking for payment, so nothing was paid. Try again later.');
    }

    const message = cliError(result);
    // The CLI only saves a signed payment from its two post-signing failures, both reported as
    // INTERNAL, so a pre-payment code and a saved payment cannot describe the same call.
    const { mine, wrongSellers } = await scanNewPaymentLogs(this.logDir, before, expect, SELLER);
    if (wrongSellers.length) {
      const warning = await this.halt(`A payment of this draw went to ${wrongSellers.join(', ')}, not the D20DAO seller ${SELLER}. Tell the user at once.`);
      return { ok: false, data: { error: warning, charged: 'unknown', warning, next: DO_NOT_REPEAT, detail: message } };
    }
    if (failedBeforePayment(result)) {
      if (!mine.length) {
        await this.release(reservation);
        return notCharged(this.setupHint(message));
      }
      return unknown(`${message} A signed payment was saved even so, so this outcome is unclear.`, mine[0]!.paymentId);
    }
    if (mine.length > 1) {
      return unknown(`${message} Several signed payments were saved during this call, so none can be resent safely.`);
    }
    if (mine.length === 1) return this.recover(mine[0]!, json, reservation, body, paid, message);
    return unknown(message);
  }

  /** The CLI signed a payment but got no answer: resend exactly that payment, which the API honours at most once. */
  private async recover(
    saved: SavedPayment,
    json: string,
    reservation: Reservation,
    body: Record<string, unknown>,
    paid: Record<string, unknown>,
    message: string,
  ): Promise<Outcome> {
    let answer: { httpStatus: number; body: any };
    try {
      answer = await resendPayment(this.fetch, this.config.apiBase, json, saved.paymentHeader);
    } catch (error) {
      return unknown(`${message} Resending the signed payment failed: ${(error as Error).message}`, saved.paymentId);
    }
    if ((answer.httpStatus === 200 || answer.httpStatus === 202) && typeof answer.body?.status === 'string') {
      return this.finish(answer.body as ApiResult, paid, reservation, body);
    }
    const code = answer.body?.error?.code ?? answer.body?.code;
    const reason = answer.body?.error?.message ?? (typeof answer.body?.error === 'string' ? answer.body.error : `HTTP ${answer.httpStatus}`);
    const refused = [400, 402, 413, 429, 503].includes(answer.httpStatus) || (answer.httpStatus === 409 && code === 'payment_pending');
    if (refused) {
      await this.release(reservation);
      return notCharged(`The payment did not go through, so nothing was charged: ${reason}`, { paymentId: saved.paymentId });
    }
    return unknown(`${message} The API answered the resent payment with HTTP ${answer.httpStatus}: ${reason}`, saved.paymentId);
  }

  private async finish(
    first: ApiResult,
    paid: Record<string, unknown>,
    reservation: Reservation,
    body: Record<string, unknown>,
    warning?: string,
  ): Promise<Outcome> {
    let current = first;
    if (!FINAL.has(current.status) && typeof current.paymentId === 'string' && PAYMENT_ID.test(current.paymentId)) {
      current = await waitForResult(this.fetch, this.config.apiBase, current, current.paymentId, {
        timeoutMs: POLL_MS,
        sleep: this.deps.sleep,
        now: this.deps.now,
      });
    }
    const data = summarize(current, body);
    if (warning) data.warning = warning;
    if (current.status === 'rejected') {
      await this.release(reservation);
      data.charged = false;
      return { ok: false, data };
    }
    data.paid = { ...paid, leftToday: await this.leftToday() };
    data.charged = true;
    if (current.status === 'fulfilled') return { ok: !warning, data };
    if (current.status === 'refund_due') {
      data.next = `Paid but not served: D20DAO owes a refund for this paymentId. ${DO_NOT_REPEAT}`;
      return { ok: false, data };
    }
    data.next = `Still in progress. Call get_result with this paymentId in a few seconds. ${DO_NOT_REPEAT}`;
    return { ok: true, data };
  }

  async getResult(input: { paymentId?: string; requestId?: string }): Promise<Outcome> {
    const paymentId = input.paymentId?.trim() || undefined;
    const requestId = input.requestId?.trim() || undefined;
    if ((paymentId === undefined) === (requestId === undefined)) return { ok: false, data: { error: 'give exactly one of paymentId or requestId' } };
    try {
      const result = paymentId
        ? await getPayment(this.fetch, this.config.apiBase, paymentId)
        : await getRequest(this.fetch, this.config.apiBase, requestId!);
      return { ok: true, data: summarize(result) };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, data: { error: error.message, httpStatus: error.httpStatus } };
      return { ok: false, data: { error: (error as Error).message } };
    }
  }
}

function asRepeat(outcome: Outcome): Outcome {
  const repeat =
    outcome.data.charged === true
      ? 'This is an identical draw made moments ago, returned without paying again. To draw again, give a different seed.'
      : `An identical draw was already paid for moments ago and its outcome is still unsettled, so this call paid nothing. ${DO_NOT_REPEAT}`;
  return { ...outcome, data: { ...outcome.data, repeat } };
}

/** The fields an agent needs, with the proof and transaction links; the full answer stays one get_result away. */
function summarize(result: ApiResult, body?: Record<string, unknown>): Record<string, unknown> {
  const links = (result.links ?? {}) as Record<string, string>;
  const items = Array.isArray(body?.items) ? (body!.items as string[]) : undefined;
  const picked =
    result.picked ??
    (items && result.status === 'fulfilled' && Array.isArray(result.result) ? (result.result as number[]).map((i) => items[i]) : undefined);
  const data: Record<string, unknown> = {
    status: result.status,
    stage: result.stage,
    message: result.status === 'fulfilled' ? undefined : result.message,
    operation: result.operation,
    result: result.result,
    outcome: result.outcome,
    picked,
    seed: result.seed,
    requestId: result.requestId,
    paymentId: result.paymentId,
    replaces: result.replaces,
    replacedBy: result.replacedBy,
    proof: links.proof,
    requestTx: links.request ?? result.requestTx,
    fulfillmentTx: links.fulfillment ?? result.fulfillmentTx,
    statusUrl: links.status ?? result.statusUrl,
  };
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  return data;
}
