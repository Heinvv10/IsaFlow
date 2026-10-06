/**
 * DOCNUM: the numbering wait is bounded at 5 s (sec-docnum F1).
 *
 * Every numbering trigger function — the eight of 858 and 857's journal one — bounds its wait for the number lock
 * at 5 s, tighten-only: a caller with no lock_timeout (or a looser one) gets 5 s, a caller with a tighter one keeps
 * it, and the caller's value is put back afterwards. Before, an insert waited with no limit behind any open
 * transaction that had numbered a journal or a document for the company and year, holding its pool connection:
 * one company could fill the shared pool. Now it fails 55P03, which the routes answer 503 + Retry-After (D11).
 *
 * The key is held by hand here (`pg_advisory_xact_lock` on the exact key the triggers take), so every waiter is
 * blocked on the numbering lock and on nothing else. Each waiter connection has statement_timeout = 20 s: a function
 * that lost its bound fails 57014 at 20 s instead of hanging the file, and the test tells the two apart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import customerPayments from '../../pages/api/accounting/customer-payments';
import journalEntries from '../../pages/api/accounting/journal-entries';
import { sql } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { CASES, dropScope, errText, insertDoc, insertJournal, seedScope, type Scope } from './helpers/docnumFixture';
import { dropFixture, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { expenseAccountOf, journalInput } from './helpers/jenumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const YEAR = 2033;
/** The route fixture's open fiscal year. */
const ROUTE_YEAR = 2026;

type Timed = { code: string; ms: number };

/** Runs `fn` on a fresh connection (statement_timeout 20 s, plus `setup`) and reports how it failed, and when. */
async function timed(fn: (c: Client) => Promise<unknown>, setup = ''): Promise<Timed> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    await c.query(`SET statement_timeout = '20s'${setup ? `; ${setup}` : ''}`);
    const t0 = Date.now();
    try {
      await fn(c);
      return { code: 'ok', ms: Date.now() - t0 };
    } catch (err) {
      return { code: String((err as { code?: string }).code ?? errText(err)), ms: Date.now() - t0 };
    }
  } finally {
    await c.end();
  }
}

let admin: Client;
let scope: Scope | undefined;
let fx: Fixture | undefined;
let token = '';

describeIfDb('DOCNUM: a numbering insert waits at most 5 s', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    scope = await seedScope(admin, 'DOCNUM-TMO');
    fx = await seedFixture('DOCNUM-TMO-R', DATABASE_URL!);
    token = await seedRouteUser(fx, 'docnum');
  }, 60000);

  afterAll(async () => {
    try {
      if (scope) await dropScope(admin, scope);
      if (fx) { await dropRouteUser(fx); await dropFixture(fx); }
    } finally {
      await admin?.end();
    }
  }, 60000);

  /** Holds the company key (857), and the group key (858) when given, for `year` while `body` runs. */
  async function holdingKeys<T>(
    companyId: string, groupId: string | null, body: () => Promise<T>, year = YEAR,
  ): Promise<T> {
    const h = new Client({ connectionString: DATABASE_URL });
    await h.connect();
    try {
      await h.query('BEGIN');
      await h.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 857))', [`${companyId}:${year}`]);
      if (groupId) await h.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 858))', [`${groupId}:${year}`]);
      // Bounded, so a waiter that lost its 5 s bound fails THIS test at 25 s instead of hanging on the key until the
      // test times out — the finally releases the key either way.
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('still waiting on the numbering key after 25 s')), 25000);
      });
      try {
        return await Promise.race([body(), limit]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await h.query('ROLLBACK');
      await h.end();
    }
  }

  /** All nine inserts at once, each on its own connection with `setup`, while the keys are held. */
  const allNine = (setup: string) => holdingKeys(scope!.companyId, scope!.groupId, () => Promise.all([
    ...CASES.map((k) => timed((c) => insertDoc(c, k, scope!, YEAR), setup).then((r) => [k.fn, r] as const)),
    timed((c) => insertJournal(c, scope!, YEAR), setup).then((r) => ['generate_journal_entry_number', r] as const),
  ]));

  // Tighten-only: the function bounds the wait at 5 s when the caller has no bound or a looser one, and keeps a
  // caller's tighter bound — withRowLockBudget hands a D8 flow's REMAINING budget down this way (sec-docnum N1).
  it.each([
    ['no lock_timeout (0)', '', 4500, 10000],
    ['a looser 30 s', "SET lock_timeout = '30s'", 4500, 10000],
    ['a tighter 500 ms', "SET lock_timeout = '500ms'", 400, 2500],
  ] as const)('caller with %s: all nine functions give up with 55P03 in the bound', async (_label, setup, min, max) => {
    for (const [fn, r] of await allNine(setup)) {
      expect(r.code, `${fn}: ${JSON.stringify(r)}`).toBe('55P03');
      expect(r.ms, `${fn}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(min);
      expect(r.ms, `${fn}: ${JSON.stringify(r)}`).toBeLessThan(max);
    }
  }, 60000);

  it("the caller's lock_timeout is unchanged after a numbered insert, and after a timeout rolled back to a savepoint",
    async () => {
      const cp = CASES.find((k) => k.table === 'customer_payments')!;
      const c = new Client({ connectionString: DATABASE_URL });
      await c.connect();
      const show = async (): Promise<string> => String((await c.query('SHOW lock_timeout')).rows[0].lock_timeout);
      try {
        await c.query('BEGIN');
        expect(await show()).toBe('0');
        await insertDoc(c, cp, scope!, YEAR + 1); // nobody holds YEAR + 1: numbered without a wait
        expect(await show(), 'an unbounded caller stays unbounded').toBe('0');
        await c.query("SET LOCAL lock_timeout = '750ms'");
        await insertDoc(c, cp, scope!, YEAR + 1);
        expect(await show()).toBe('750ms');
        const r = await holdingKeys(scope!.companyId, null, async () => {
          await c.query('SAVEPOINT s');
          const t0 = Date.now();
          const code = await insertDoc(c, cp, scope!, YEAR).then(() => 'ok', (e: unknown) => String((e as { code?: string }).code));
          const ms = Date.now() - t0;
          await c.query('ROLLBACK TO SAVEPOINT s');
          return { code, ms };
        });
        expect(r.code).toBe('55P03');
        expect(r.ms, 'the caller\'s 750 ms, not 5 s').toBeLessThan(2500);
        expect(await show(), 'after ROLLBACK TO SAVEPOINT').toBe('750ms');
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    }, 60000);

  it('customer-payments POST held past 5 s: 503 + Retry-After, nothing written', async () => {
    const invoiceId = await seedInvoice(fx!, { number: 'DOCNUM-TMO', date: `${ROUTE_YEAR}-02-01`, total: 100 });
    const out = await holdingKeys(fx!.companyId, null, () => callRoute(fx!, token, customerPayments, {
      clientId: fx!.customerId, paymentDate: `${ROUTE_YEAR}-02-02`, totalAmount: 40, paymentMethod: 'eft',
      allocations: [{ invoiceId, amount: 40 }],
    }), ROUTE_YEAR);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(503);
    expect((out as unknown as { getHeader(n: string): unknown }).getHeader('retry-after')).toBe('2');
    expect(JSON.stringify(out.body)).toMatch(/ROW_LOCK_TIMEOUT/);
    expect(((await sql`SELECT COUNT(*)::int AS n FROM customer_payments
      WHERE company_id = ${fx!.companyId}::UUID`) as { n: number }[])[0]!.n).toBe(0);
  }, 60000);

  it('journal-entries POST held past 5 s: 503 + Retry-After, nothing written', async () => {
    const input = journalInput(await expenseAccountOf(fx!), fx!.bankAccountId, `${ROUTE_YEAR}-02-03`, 41);
    const out = await holdingKeys(fx!.companyId, null, () => callRoute(fx!, token, journalEntries, {
      entryDate: input.entryDate, description: input.description, lines: input.lines,
    }), ROUTE_YEAR);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(503);
    expect((out as unknown as { getHeader(n: string): unknown }).getHeader('retry-after')).toBe('2');
    expect(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${fx!.companyId}::UUID AND description = ${input.description}`) as { n: number }[])[0]!.n)
      .toBe(0);
  }, 60000);
});
