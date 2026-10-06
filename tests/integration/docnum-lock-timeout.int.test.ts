/**
 * DOCNUM: the numbering wait is bounded at 5 s (sec-docnum F1).
 *
 * Every numbering trigger function — the eight of 858 and 857's journal one — runs with `lock_timeout = 5s`
 * (function-level SET). Before, an insert waited with no limit behind any open transaction that had numbered a
 * journal or a document for the company and year, holding its pool connection: one company could fill the shared
 * pool. Now it fails 55P03 after 5 s, which the routes already answer 503 + Retry-After (D11).
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

  it('all nine numbering functions give up with 55P03 after about 5 s (caller sets no lock_timeout)', async () => {
    const out = await holdingKeys(scope!.companyId, scope!.groupId, () => Promise.all([
      ...CASES.map((k) => timed((c) => insertDoc(c, k, scope!, YEAR)).then((r) => [k.fn, r] as const)),
      timed((c) => insertJournal(c, scope!, YEAR)).then((r) => ['generate_journal_entry_number', r] as const),
    ]));
    for (const [fn, r] of out) {
      expect(r.code, `${fn}: ${JSON.stringify(r)}`).toBe('55P03');
      expect(r.ms, `${fn}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(4500);
      expect(r.ms, `${fn}: ${JSON.stringify(r)}`).toBeLessThan(10000);
    }
  }, 60000);

  // The other effect of a function-level SET, pinned so nobody mistakes it for a bug: inside the function the 5 s
  // replaces a caller's TIGHTER lock_timeout too.
  it("a caller's tighter lock_timeout (1 s) is 5 s inside the numbering function", async () => {
    const cp = CASES.find((k) => k.table === 'customer_payments')!;
    const r = await holdingKeys(scope!.companyId, null,
      () => timed((c) => insertDoc(c, cp, scope!, YEAR), "SET lock_timeout = '1s'"));
    expect(r.code, JSON.stringify(r)).toBe('55P03');
    expect(r.ms, JSON.stringify(r)).toBeGreaterThanOrEqual(4500);
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
