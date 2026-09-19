// The daily spending record (UTC days), shared by every server process of this user.
// A draw reserves its price before anything is paid, under a lock file, so the cap holds across
// processes and a crash or a failed write can never leave a payment unrecorded. A reservation is
// released only when the draw is known not to have been charged.
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

interface Day {
  day: string;
  spentAtomic: string;
  draws: number;
}

export interface Reservation {
  day: string;
  amountAtomic: bigint;
}

export class LedgerError extends Error {}

const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

export class Ledger {
  private readonly file: string;
  private readonly lock: string;

  constructor(
    private readonly home: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(home, 'spend.json');
    this.lock = join(home, 'spend.lock');
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** Today's totals. Only a missing file means nothing was spent; anything unreadable is an error. */
  async read(): Promise<{ spentAtomic: bigint; draws: number }> {
    const day = await this.load();
    return { spentAtomic: BigInt(day.spentAtomic), draws: day.draws };
  }

  /** Reserves a draw's price, or returns the amount already spent if the cap would be exceeded. */
  async reserve(amountAtomic: bigint, limitAtomic: bigint): Promise<Reservation | { refusedAt: bigint }> {
    return this.locked(async () => {
      const day = await this.load();
      const spent = BigInt(day.spentAtomic);
      if (spent + amountAtomic > limitAtomic) return { refusedAt: spent };
      await this.save({ day: day.day, spentAtomic: (spent + amountAtomic).toString(), draws: day.draws + 1 });
      return { day: day.day, amountAtomic };
    });
  }

  /** Gives a reservation back after a draw that was not charged. A reservation from an earlier day has already lapsed. */
  async release(reservation: Reservation): Promise<void> {
    await this.locked(async () => {
      const day = await this.load();
      if (day.day !== reservation.day) return;
      const spent = BigInt(day.spentAtomic) - reservation.amountAtomic;
      await this.save({ day: day.day, spentAtomic: (spent > 0n ? spent : 0n).toString(), draws: Math.max(day.draws - 1, 0) });
    });
  }

  private async load(): Promise<Day> {
    const today = this.today();
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (code(error) === 'ENOENT') return { day: today, spentAtomic: '0', draws: 0 };
      throw new LedgerError(`cannot read the spending record ${this.file}: ${(error as Error).message}`);
    }
    let day: Day;
    try {
      day = JSON.parse(text) as Day;
      if (typeof day.day !== 'string' || !/^\d+$/.test(day.spentAtomic) || !Number.isInteger(day.draws)) throw new Error('bad fields');
    } catch {
      throw new LedgerError(`the spending record ${this.file} is damaged; fix or delete it to resume paid draws`);
    }
    return day.day === today ? day : { day: today, spentAtomic: '0', draws: 0 };
  }

  private async save(day: Day): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(day) + '\n', { mode: 0o600 });
    // On Windows a scanner or indexer can hold the target for a moment; retry the rename briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, this.file);
        return;
      } catch (error) {
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(code(error) ?? '')) {
          await rm(tmp, { force: true }).catch(() => undefined);
          throw error;
        }
        await sleep(25 * (attempt + 1));
      }
    }
  }

  private async locked<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(this.home, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await (await open(this.lock, 'wx')).close();
        break;
      } catch (error) {
        // Windows reports a lock another process is creating or deleting as EPERM or EBUSY, not EEXIST.
        if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? '')) throw error;
        const age = await stat(this.lock).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > STALE_LOCK_MS) {
          await rm(this.lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new LedgerError(`the spending record is locked (${this.lock}); another d20dao server may be stuck`);
        await sleep(20 + Math.floor(Math.random() * 40));
      }
    }
    try {
      return await task();
    } finally {
      await rm(this.lock, { force: true }).catch(() => undefined);
    }
  }
}
