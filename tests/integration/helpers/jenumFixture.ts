/**
 * JENUM (journal numbering under concurrency) — shared by the jenum-*.int.test.ts files.
 *
 * A journal is "held" by creating it through the real `createJournalEntry` on a pool client inside an
 * open transaction, so its number is minted and uncommitted. A second writer is then started on its own
 * connection, and the holder is released only once `pg_blocking_pids` proves the writer is waiting on
 * THAT backend — scoped by pid, because the fixture database is shared and an unscoped probe can match
 * a peer's session. No sleep decides the outcome.
 */
import { Pool, type PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import type { JournalEntryCreateInput } from '@/modules/accounting/types/gl.types';
import { randomUUID } from 'crypto';
import { runOn, type Fixture } from './l1FifoFixture';

type Row = Record<string, unknown>;

export interface Held { client: PoolClient; pid: number; entryNumber: string; done: boolean }

/** The fixture's expense account; the bank account is `fx.bankAccountId`. */
export async function expenseAccountOf(fx: Fixture): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = '6000'`) as Row[])[0]!.id);
}

/** An open calendar-year period beside the fixture's 2026 one. */
export async function openYear(fx: Fixture, year: number): Promise<void> {
  await sql`
    INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
    VALUES (${fx.companyId}::UUID, ${`FY${year} ${fx.tag}`}, 1, ${year}, ${`${year}-01-01`}::DATE,
            ${`${year}-12-31`}::DATE, 'open')`;
}

/** Every row `seedCompanyWithId` writes, so a run killed half-way does not block the next one's INSERT. */
async function purgeCompany(id: string): Promise<void> {
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${id}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${id}::UUID`;
  await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${id}::UUID)`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${id}::UUID`;
  await sql`DELETE FROM fiscal_periods WHERE company_id = ${id}::UUID`;
  await sql`DELETE FROM companies WHERE id = ${id}::UUID`;
}

/**
 * A company with a GIVEN id (the reviewers' hash-colliding pair), an expense and a bank account, and an open
 * 2026. The id is fixed, so leftovers of an earlier run are purged first. Tear down with `dropFixture`.
 */
export async function seedCompanyWithId(id: string, prefix: string, databaseUrl: string): Promise<Fixture> {
  await purgeCompany(id);
  const tag = `${prefix}-${Date.now()}`;
  await sql`INSERT INTO companies (id, name, registration_number, created_at)
            VALUES (${id}::UUID, ${`${prefix} ${tag}`}, ${tag}, NOW())`;
  const acct = async (code: string, type: string, subtype: string, normal: string): Promise<string> => String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
                             is_active, is_system_account)
    VALUES (${id}::UUID, ${code}, ${`${code} ${tag}`}, ${type}, ${subtype}, ${normal}, true, true)
    RETURNING id`) as Row[])[0]!.id);
  await acct('6000', 'expense', 'default_expense', 'debit');
  const bankAccountId = await acct('1000', 'asset', 'bank', 'debit');
  const fx: Fixture = {
    pool: new Pool({ connectionString: databaseUrl, max: 3 }), companyId: id, userId: randomUUID(),
    supplierId: '', customerId: '', bankAccountId, tag,
  };
  await sql`
    INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
    VALUES (${id}::UUID, ${`FY26 ${tag}`}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;
  return fx;
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
  try {
    await client.query('BEGIN');
    const pid = await backendPid(client);
    const je = await runOn(fx, client, () => createJournalEntry(fx.companyId, input, fx.userId));
    return { client, pid, entryNumber: je.entryNumber, done: false };
  } catch (err) {
    // Never hand back an open transaction: it would hold its locks into the next test and block teardown.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    throw err;
  }
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
