/**
 * JENUM: two journals numbered at the same moment for one company and year no longer collide.
 *
 * `generate_journal_entry_number` mints MAX(seq)+1 over the company's COMMITTED numbers. Before migration 857 a
 * second writer read the same MAX as an uncommitted first writer, minted the same number, waited on
 * `uq_gl_je_company_entry_number` until the first committed, and then failed 23505. Migration 857 takes
 * `pg_advisory_xact_lock(857, hashtext('<company>:<year>'))` before the MAX, so the second writer waits on the
 * lock instead and mints the next number. Everything here goes through the real `createJournalEntry`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import {
  errText, expenseAccountOf, holdJournal, journalInput, nextNumber, open2027, release, settle,
  settledWithin, waitForBlocked,
} from './helpers/jenumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

let fx: Fixture, other: Fixture;
let expense = '', otherExpense = '';

async function numbersOf(f: Fixture): Promise<string[]> {
  return ((await sql`
    SELECT entry_number FROM gl_journal_entries WHERE company_id = ${f.companyId}::UUID
    ORDER BY entry_number`) as Row[]).map((r) => String(r.entry_number));
}

describeIfDb('JENUM: journal numbering under concurrent posting', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('JENUM', DATABASE_URL!);
    other = await seedFixture('JENUM-B', DATABASE_URL!);
    await open2027(fx);
    expense = await expenseAccountOf(fx);
    otherExpense = await expenseAccountOf(other);
  }, 60000);

  afterAll(async () => {
    if (fx) await dropFixture(fx);
    if (other) await dropFixture(other);
  }, 60000);

  it('same company + year: the second writer waits for the first, then gets the next number (no 23505)', async () => {
    const a = await holdJournal(fx, journalInput(expense, fx.bankAccountId, '2026-03-01'));
    const b = await fx.pool.connect();
    try {
      await b.query('BEGIN');
      const pB = settle(runOn(fx, b, () => createJournalEntry(fx.companyId,
        journalInput(expense, fx.bankAccountId, '2026-03-02'), fx.userId)));
      await waitForBlocked(a.pid);
      expect(await settledWithin(pB, 300), 'B must wait while A holds an uncommitted number').toBe(false);
      await release(a, 'COMMIT');
      const out = await pB;
      expect(out.ok, out.ok ? '' : errText(out.error)).toBe(true);
      expect(out.ok && out.value.entryNumber).toBe(nextNumber(a.entryNumber));
      await b.query('COMMIT');
    } finally {
      // A first: a B still waiting on A would queue this ROLLBACK behind its own INSERT.
      await release(a, 'ROLLBACK');
      await b.query('ROLLBACK').catch(() => undefined);
      b.release();
    }
  }, 60000);

  it('same company, DIFFERENT year: no wait', async () => {
    const a = await holdJournal(fx, journalInput(expense, fx.bankAccountId, '2026-04-01'));
    try {
      const pB = settle(createJournalEntry(fx.companyId,
        journalInput(expense, fx.bankAccountId, '2027-04-01'), fx.userId));
      expect(await settledWithin(pB, 5000), 'a 2027 journal must not wait on a held 2026 one').toBe(true);
      const out = await pB;
      expect(out.ok, out.ok ? '' : errText(out.error)).toBe(true);
      expect(out.ok && out.value.entryNumber).toMatch(/^JE-2027-\d{5}$/);
    } finally {
      await release(a, 'ROLLBACK');
    }
  }, 60000);

  it('DIFFERENT company, same year: no wait', async () => {
    const a = await holdJournal(fx, journalInput(expense, fx.bankAccountId, '2026-05-01'));
    try {
      const pB = settle(createJournalEntry(other.companyId,
        journalInput(otherExpense, other.bankAccountId, '2026-05-01'), other.userId));
      expect(await settledWithin(pB, 5000), "another company's journal must not wait").toBe(true);
      const out = await pB;
      expect(out.ok, out.ok ? '' : errText(out.error)).toBe(true);
    } finally {
      await release(a, 'ROLLBACK');
    }
  }, 60000);

  it("the wait is bounded by the caller's lock_timeout: 55P03, not a hang", async () => {
    const a = await holdJournal(fx, journalInput(expense, fx.bankAccountId, '2026-06-01'));
    const b = await fx.pool.connect();
    try {
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '1s'");
      const t0 = Date.now();
      const out = await settle(runOn(fx, b, () => createJournalEntry(fx.companyId,
        journalInput(expense, fx.bankAccountId, '2026-06-02'), fx.userId)));
      const ms = Date.now() - t0;
      expect(out.ok).toBe(false);
      expect((out as { error: { code?: string } }).error.code, errText((out as { error: unknown }).error)).toBe('55P03');
      expect(ms).toBeLessThan(5000);
    } finally {
      await b.query('ROLLBACK').catch(() => undefined);
      b.release();
      await release(a, 'ROLLBACK');
    }
  }, 60000);

  it('a burst of 8 writers queued behind one holder: 8 distinct consecutive numbers, 0 errors', async () => {
    const a = await holdJournal(fx, journalInput(expense, fx.bankAccountId, '2026-07-01'));
    const burst = Array.from({ length: 8 }, (_, i) => settle(createJournalEntry(fx.companyId,
      journalInput(expense, fx.bankAccountId, '2026-07-02', 20 + i), fx.userId)));
    try {
      await waitForBlocked(a.pid, 8);
      await release(a, 'COMMIT');
    } finally {
      await release(a, 'ROLLBACK');
    }
    const outs = await Promise.all(burst);
    expect(outs.filter((o) => !o.ok).map((o) => errText((o as { error: unknown }).error))).toEqual([]);
    const got = outs.map((o) => (o.ok ? o.value.entryNumber : '')).sort();
    const want = [nextNumber(a.entryNumber)];
    while (want.length < 8) want.push(nextNumber(want[want.length - 1]!));
    expect(got).toEqual(want);
    expect(new Set(await numbersOf(fx)).size).toBe((await numbersOf(fx)).length);
  }, 90000);
});
