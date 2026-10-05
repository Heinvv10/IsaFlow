/**
 * JENUM (journal numbering under concurrency) — shared by the jenum-*.int.test.ts files.
 *
 * A journal is "held" by creating it through the real `createJournalEntry` on a pool client inside an
 * open transaction, so its number is minted and uncommitted. A second writer is then started on its own
 * connection, and the holder is released only once `pg_blocking_pids` proves the writer is waiting on
 * THAT backend — scoped by pid, because the fixture database is shared and an unscoped probe can match
 * a peer's session. No sleep decides the outcome.
 */
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import type { JournalEntryCreateInput } from '@/modules/accounting/types/gl.types';
import { runOn, type Fixture } from './l1FifoFixture';

type Row = Record<string, unknown>;

export interface Held { client: PoolClient; pid: number; entryNumber: string; done: boolean }

/** The fixture's expense account; the bank account is `fx.bankAccountId`. */
export async function expenseAccountOf(fx: Fixture): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = '6000'`) as Row[])[0]!.id);
}

/** An open 2027 period beside the fixture's 2026 one, for the different-year case. */
export async function open2027(fx: Fixture): Promise<void> {
  await sql`
    INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
    VALUES (${fx.companyId}::UUID, ${`FY27 ${fx.tag}`}, 1, 2027, '2027-01-01', '2027-12-31', 'open')`;
}

export function journalInput(expense: string, bank: string, entryDate: string, amount = 10): JournalEntryCreateInput {
  return {
    entryDate, description: `jenum ${entryDate} ${amount}`, source: 'manual',
    lines: [
      { glAccountId: expense, debit: amount, credit: 0, description: 'jenum DR' },
      { glAccountId: bank, debit: 0, credit: amount, description: 'jenum CR' },
    ],
  };
}

export async function backendPid(client: PoolClient): Promise<number> {
  return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
}

/** A journal created and left UNCOMMITTED on its own connection. */
export async function holdJournal(fx: Fixture, input: JournalEntryCreateInput): Promise<Held> {
  const client = await fx.pool.connect();
  await client.query('BEGIN');
  const pid = await backendPid(client);
  const je = await runOn(fx, client, () => createJournalEntry(fx.companyId, input, fx.userId));
  return { client, pid, entryNumber: je.entryNumber, done: false };
}

/** Ends a held transaction and returns its client to the pool; a second call is a no-op. */
export async function release(h: Held, verb: 'COMMIT' | 'ROLLBACK'): Promise<void> {
  if (h.done) return;
  h.done = true;
  try { await h.client.query(verb); } finally { h.client.release(); }
}

/** Resolves once `count` backends are waiting on `holderPid`; throws after `ms`. */
export async function waitForBlocked(holderPid: number, count = 1, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const n = Number(((await sql`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
      WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`) as Row[])[0]!.n);
    if (n >= count) return;
    if (Date.now() > deadline) throw new Error(`${n}/${count} backends ever blocked on pid ${holderPid}`);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  return p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

/** True when `p` settles within `ms`. */
export async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const done = p.then(() => true as const, () => true as const);
  const out = await Promise.race([done, timeout]);
  clearTimeout(timer);
  return out;
}

/** `JE-2026-00007` → `JE-2026-00008`. */
export function nextNumber(n: string): string {
  const [prefix, year, seq] = n.split('-');
  return `${prefix}-${year}-${String(Number(seq) + 1).padStart(5, '0')}`;
}

export function errText(e: unknown): string {
  const x = e as { code?: string; constraint?: string; message?: string };
  return `${x?.code ?? ''} ${x?.constraint ?? ''} ${x?.message ?? String(e)}`;
}
