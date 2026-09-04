/**
 * The row lock that stops two reclassification batches moving the same lines.
 *
 * THE RACE IT CLOSES. Two requests with DIFFERENT idempotency keys — two agent
 * sessions, or one agent retrying under a fresh key after a timeout — are not
 * serialised by the registry's idempotency lock, which keys on
 * (company, tool, idempotency_key). Both read the candidate lines, both see
 * `already_reclassified = false` because neither has committed its batch rows,
 * and both post. R11,318,214.27 moves twice.
 *
 * `FOR UPDATE` with a 5s `lock_timeout`, following `bankTxLock.ts` — the
 * pattern this repo already added after a double-post got through the same way.
 *
 * DB-gated because a lock is not a shape. A mocked `sql` template would happily
 * "acquire" a lock Postgres never took, which is the failure this whole class of
 * test exists to catch. Two REAL connections contend here.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  lockReclassLinesForUpdate,
  ReclassLineLockTimeoutError,
} from '@/modules/accounting/services/gl/reclassification/lineLock';

type Ctx = Parameters<typeof als.run>[0];
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

/**
 * A DEDICATED connection, not one from the shared pool.
 *
 * This is the only test in the suite that needs TWO connections at once, and a
 * pooled one stays open for the life of the vitest worker after it is released.
 * With ~660 test files across many workers against a `max_connections` of 100
 * that is real pressure, and it showed up as unrelated DB-gated tests failing
 * under parallel file execution while passing on their own. A `Client` that is
 * `end()`ed gives the connection straight back.
 */
async function dedicated(): Promise<PoolClient> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c as unknown as PoolClient;
}

async function done(c: PoolClient | null): Promise<void> {
  if (c) await (c as unknown as Client).end().catch(() => undefined);
}

interface Lines {
  companyId: string;
  ids: string[];
}

/**
 * Two COMMITTED journal lines, so a second connection can see and contend for
 * them. Cleaned up by id at the end — they cannot live in the test's own
 * rolled-back transaction, because the whole point is cross-connection
 * visibility.
 */
async function makeCommittedLines(client: PoolClient): Promise<Lines | null> {
  // Its own company, for the reason the other DB-gated reclassification files
  // give: (company_id, entry_number) is unique and every borrower of "the first
  // company with an open period" races the rest for the next number.
  const { rows: co } = await client.query<{ id: string }>(
    "INSERT INTO companies (name) VALUES ('Line lock fixture co') RETURNING id",
  );
  const companyId = co[0]!.id;
  await client.query(
    `INSERT INTO fiscal_periods
       (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'Fixture period', 1, EXTRACT(YEAR FROM CURRENT_DATE)::int,
             date_trunc('year', CURRENT_DATE)::date,
             (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date,
             'open')`,
    [companyId],
  );

  const n = Math.floor(Math.random() * 1e9);
  const { rows: acct } = await client.query<{ id: string }>(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
     VALUES ($1, $2, 'Line lock fixture', 'expense', 'debit', true) RETURNING id`,
    [companyId, `LCK${n}`],
  );
  const { rows: entry } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries
       (company_id, entry_date, fiscal_period_id, description, source, status, created_by, posted_at)
     SELECT $1, CURRENT_DATE, fp.id, 'line lock fixture', 'manual', 'posted', $2, now()
       FROM fiscal_periods fp
      WHERE fp.company_id = $1 AND fp.start_date <= CURRENT_DATE AND fp.end_date >= CURRENT_DATE
      LIMIT 1
     RETURNING id`,
    [companyId, USER_ID],
  );
  const ids: string[] = [];
  for (const [d, c] of [[100, 0], [0, 100]] as const) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, entry[0]!.id, acct[0]!.id, d, c],
    );
    ids.push(rows[0]!.id);
  }
  return { companyId, ids: ids.sort() };
}

async function cleanup(client: PoolClient, lines: Lines | null): Promise<void> {
  if (!lines) return;
  await client.query(
    `DELETE FROM gl_journal_entries WHERE id IN (
       SELECT journal_entry_id FROM gl_journal_lines WHERE id = ANY($1::UUID[]))`,
    [lines.ids],
  );
  await client.query(
    "DELETE FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'LCK%'",
    [lines.companyId],
  );
  await client.query('DELETE FROM fiscal_periods WHERE company_id = $1', [lines.companyId]);
  await client.query('DELETE FROM companies WHERE id = $1', [lines.companyId]);
}

describe('lockReclassLinesForUpdate (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('a second batch over the SAME lines cannot proceed until the first commits', async (ctx) => {
    assertNotProductionDb('This test inserts and deletes journal entries and lines.');
    const a = await dedicated();
    const b = await dedicated();
    let lines: Lines | null = null;
    try {
      lines = await makeCommittedLines(a);
      if (!lines) { ctx.skip('no company with an open period covering today'); return; }

      await a.query('BEGIN');
      const locked = await als.run(ctxFor(a, lines.companyId), () =>
        lockReclassLinesForUpdate(lines!.companyId, lines!.ids));
      expect(locked).toEqual(lines.ids);

      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '300ms'");
      await expect(
        als.run(ctxFor(b, lines.companyId), () =>
          lockReclassLinesForUpdate(lines!.companyId, lines!.ids)),
      ).rejects.toBeInstanceOf(ReclassLineLockTimeoutError);
      await b.query('ROLLBACK');

      // Released on COMMIT — no unlock path to forget, and the registry's
      // savepoint rollback releases it the same way.
      await a.query('COMMIT');
      await b.query('BEGIN');
      await als.run(ctxFor(b, lines.companyId), () =>
        lockReclassLinesForUpdate(lines!.companyId, lines!.ids));
      await b.query('ROLLBACK');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await cleanup(a, lines).catch(() => undefined);
      await done(a);
      await done(b);
    }
  }, 60_000);

  it.skipIf(!reachable)('does NOT block a batch over different lines', async (ctx) => {
    // The contended resource is the SET OF LINES, not the account: two batches
    // over non-overlapping windows genuinely do not conflict and must not be
    // made to wait for each other.
    assertNotProductionDb('This test inserts and deletes journal entries and lines.');
    const a = await dedicated();
    const b = await dedicated();
    let one: Lines | null = null;
    let two: Lines | null = null;
    try {
      one = await makeCommittedLines(a);
      two = await makeCommittedLines(a);
      if (!one || !two) { ctx.skip('no company with an open period covering today'); return; }

      await a.query('BEGIN');
      await als.run(ctxFor(a, one.companyId), () =>
        lockReclassLinesForUpdate(one!.companyId, one!.ids));

      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '2s'");
      const locked = await als.run(ctxFor(b, two.companyId), () =>
        lockReclassLinesForUpdate(two!.companyId, two!.ids));
      expect(locked).toEqual(two.ids);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await cleanup(a, one).catch(() => undefined);
      await cleanup(a, two).catch(() => undefined);
      await done(a);
      await done(b);
    }
  }, 60_000);

  it.skipIf(!reachable)('is fenced by company_id — another tenant\'s line is not locked', async (ctx) => {
    assertNotProductionDb('This test inserts and deletes journal entries and lines.');
    const a = await dedicated();
    let lines: Lines | null = null;
    try {
      lines = await makeCommittedLines(a);
      if (!lines) { ctx.skip('no company with an open period covering today'); return; }
      await a.query('BEGIN');
      const locked = await als.run(ctxFor(a, lines.companyId), () =>
        lockReclassLinesForUpdate('00000000-0000-0000-0000-0000000000ff', lines!.ids));
      // Real ids, wrong company: nothing comes back, so the caller moves nothing.
      expect(locked).toEqual([]);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await cleanup(a, lines).catch(() => undefined);
      await done(a);
    }
  }, 60_000);

  it.skipIf(!reachable)('returns only the lines that still exist', async (ctx) => {
    // A line deleted between the read and the lock simply does not come back,
    // and the caller must not move it — which is what the `appeared_after_lock`
    // partition rule enforces on the other side.
    assertNotProductionDb('This test inserts and deletes journal entries and lines.');
    const a = await dedicated();
    let lines: Lines | null = null;
    try {
      lines = await makeCommittedLines(a);
      if (!lines) { ctx.skip('no company with an open period covering today'); return; }
      await a.query('BEGIN');
      const ghost = '00000000-0000-4000-8000-0000000dead1';
      const locked = await als.run(ctxFor(a, lines.companyId), () =>
        lockReclassLinesForUpdate(lines!.companyId, [...lines!.ids, ghost]));
      expect(locked).toEqual(lines.ids);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await cleanup(a, lines).catch(() => undefined);
      await done(a);
    }
  }, 60_000);

  it('REFUSES to run outside a request transaction', async () => {
    // Outside one, FOR UPDATE releases the instant the SELECT returns and the
    // caller believes it is serialised when it is not. A loud failure beats a
    // lock that silently does nothing.
    await expect(lockReclassLinesForUpdate('c', ['l'])).rejects.toThrow(/request transaction/);
  });

  it('locks nothing, and asks the database nothing, for an empty batch', async () => {
    await expect(lockReclassLinesForUpdate('c', [])).resolves.toEqual([]);
  });
});
