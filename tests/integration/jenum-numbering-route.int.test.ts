/**
 * JENUM through a real route: POST /api/accounting/journal-entries while another transaction holds an
 * uncommitted journal of the same company and year.
 *
 * Before migration 857 the route minted the held number, waited on `uq_gl_je_company_entry_number`, and
 * answered the 23505 as a 400 naming the constraint. Now it waits on the numbering lock and answers 200 with
 * the next number. Under a lock_timeout the same wait ends in 55P03, which the route already answers 503 — as it
 * did before 857 (that case pins existing behaviour).
 *
 * Every connection in this file runs with lock_timeout = 2 s (PGOPTIONS, read by pg when each connection
 * opens — set before the first one and restored after the last), so the 503 case is bounded and the 200 case
 * proves the commit lands well inside it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import journalEntries from '../../pages/api/accounting/journal-entries';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { callRoute, dataOf, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { expenseAccountOf, holdJournal, journalInput, nextNumber, release, waitForBlocked } from './helpers/jenumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const priorPgOptions = process.env.PGOPTIONS;
process.env.PGOPTIONS = '-c lock_timeout=2000';
type Row = Record<string, unknown>;

let fx: Fixture;
let token = '';
let expense = '';

const routeBody = (entryDate: string, amount: number) => {
  const input = journalInput(expense, fx.bankAccountId, entryDate, amount);
  return { entryDate: input.entryDate, description: input.description, lines: input.lines };
};

async function journalsDescribed(description: string): Promise<number> {
  return Number(((await sql`
    SELECT COUNT(*)::int AS n FROM gl_journal_entries
    WHERE company_id = ${fx.companyId}::UUID AND description = ${description}`) as Row[])[0]!.n);
}

describeIfDb('JENUM: journal-entries POST under a concurrent numbering', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('JENUM-R', DATABASE_URL!);
    token = await seedRouteUser(fx, 'jenum');
    expense = await expenseAccountOf(fx);
  }, 60000);

  afterAll(async () => {
    try {
      if (fx) { await dropRouteUser(fx); await dropFixture(fx); }
    } finally {
      if (priorPgOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = priorPgOptions;
    }
  }, 60000);

  it('waits for the held journal, then answers 200 with the next number', async () => {
    const a = await holdJournal(fx, journalInput(expense, fx.bankAccountId, '2026-08-01'));
    try {
      const pRoute = callRoute(fx, token, journalEntries, routeBody('2026-08-02', 31));
      await waitForBlocked(a.pid);
      await release(a, 'COMMIT');
      const out = await pRoute;
      expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
      expect(dataOf<{ entryNumber: string }>(out).entryNumber).toBe(nextNumber(a.entryNumber));
      expect(await journalsDescribed('jenum 2026-08-02 31')).toBe(1);
    } finally {
      await release(a, 'ROLLBACK');
    }
  }, 60000);

  // Pins PRE-EXISTING behaviour, not the fix: before migration 857 the route waited on the uncommitted index entry
  // and also answered 503 under a lock_timeout, so this passes with the lock line removed. It guards "no new hang".
  it("held past the caller's lock_timeout: 503, nothing written", async () => {
    const a = await holdJournal(fx, journalInput(expense, fx.bankAccountId, '2026-09-01'));
    try {
      const t0 = Date.now();
      const out = await callRoute(fx, token, journalEntries, routeBody('2026-09-02', 32));
      expect(out.statusCode, JSON.stringify(out.body)).toBe(503);
      expect(Date.now() - t0).toBeLessThan(10000);
      expect(JSON.stringify(out.body)).toMatch(/ROW_LOCK_TIMEOUT/);
      expect(JSON.stringify(out.body)).not.toMatch(/uq_gl_je_company_entry_number|55P03/);
    } finally {
      await release(a, 'ROLLBACK');
    }
    expect(await journalsDescribed('jenum 2026-09-02 32')).toBe(0);
  }, 60000);
});
