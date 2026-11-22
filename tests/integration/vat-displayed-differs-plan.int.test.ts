/**
 * vat_displayed_differs_from_posted: behaviour, and the plan it runs under.
 *
 * Production incident 2026-11-21 (Bugsink 0e7c6050): the check hit
 * `canceling statement due to statement timeout` for a tenant imported a couple
 * of hours earlier. Postgres had no statistics for the new company_id, so under
 * the tenant-isolation policy (`company_id IN (SELECT auth.user_companies())`)
 * it estimated ONE row on every table, chose nested loops that filter on the
 * join keys instead of using their indexes, and so ran bank_transactions x
 * gl_journal_lines x gl_journal_lines once per VAT line.
 *
 * Two things are pinned here:
 *   1. the rewrite returns exactly what the old two-statement query returned
 *      (count, amount and the sample rows, with and without a limit);
 *   2. it finishes quickly for a company the planner has never seen, as the app
 *      role, with RLS on. That is the half that fails on the old query.
 *
 * Every row lives inside BEGIN ... ROLLBACK on one client.
 */
import { afterAll, describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { vatDisplayedDiffersFromPosted } from '@/modules/accounting/services/gl/integrityChecks/vatChecks';
import type { IntegrityCheckContext } from '@/modules/accounting/services/gl/integrityChecks/types';
import { AS_AT, USER, seedCompany, seedEdgeCases, seedUnseenTenant } from './helpers/vatPlanFixture';


type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: USER, companyId, claims: {} } as unknown as Ctx);

/** The query this check ran before the fix, verbatim, with a tie-break on bt.id so two runs are comparable. */
async function legacy(companyId: string, limit: number) {
  const where = sql`
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    JOIN gl_journal_lines vl ON vl.journal_entry_id = jl.journal_entry_id AND vl.company_id = bt.company_id
    JOIN gl_accounts ga ON ga.id = vl.gl_account_id AND ga.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.transaction_date <= ${AS_AT}::DATE
      AND ga.account_subtype = ANY(ARRAY['vat_input', 'vat_output']::TEXT[])
      AND ABS(vl.debit - vl.credit) > 0.005
      AND COALESCE(bt.suggested_vat_code, 'no_vat') = 'no_vat'
  `;
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(ABS(vl.debit - vl.credit)), 0) AS amount ${where}
  `) as DbRow[];
  const rows = (await sql`
    SELECT bt.id::TEXT AS id,
           COALESCE(NULLIF(bt.reference, ''), bt.bank_reference, LEFT(COALESCE(bt.description, ''), 60)) AS label,
           ABS(vl.debit - vl.credit) AS amount,
           'displayed "' || COALESCE(bt.suggested_vat_code, 'No VAT')
             || '" but posted ' || ga.account_code || ' ' || ga.account_name AS detail
    ${where}
    ORDER BY ABS(vl.debit - vl.credit) DESC, bt.id
    LIMIT ${limit}
  `) as DbRow[];
  return {
    count: Number(totals[0]?.count),
    amount: Math.round(Number(totals[0]?.amount) * 100) / 100,
    sample: rows.map((r) => ({
      id: String(r.id), label: String(r.label), amount: Math.round(Number(r.amount) * 100) / 100, detail: String(r.detail),
    })),
  };
}

async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  assertNotProductionDb('This test inserts rows (rolled back).');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const ctxOf = (companyId: string, limit: number): IntegrityCheckContext => ({ companyId, asAt: AS_AT, limit });

describe('vat_displayed_differs_from_posted: same answer as the query it replaces', () => {
  it.each([1, 2, 3, 100])('matches the old query exactly at limit %i', async (limit) => {
    await withTx(async (client) => {
      const companyId = await seedEdgeCases(client);
      await als.run(ctxFor(client, companyId), async () => {
        const before = await legacy(companyId, limit);
        const after = await vatDisplayedDiffersFromPosted(ctxOf(companyId, limit));
        expect(before.count).toBe(10);
        expect(before.amount).toBe(144.75);
        expect({ count: after.count, amount: after.amount, sample: after.sample }).toEqual(before);
      });
    });
  });

  it('orders equal amounts by bank transaction id', async () => {
    await withTx(async (client) => {
      const companyId = await seedEdgeCases(client);
      await als.run(ctxFor(client, companyId), async () => {
        const { sample } = await vatDisplayedDiffersFromPosted(ctxOf(companyId, 100));
        const ties = sample.filter((r) => r.amount === 12).map((r) => r.id);
        expect(ties).toHaveLength(6);
        expect(ties).toEqual([...ties].sort());
      });
    });
  });

  it('reports zero, not null, when nothing fails', async () => {
    await withTx(async (client) => {
      const { companyId } = await seedCompany(client, 'VAT plan empty');
      await als.run(ctxFor(client, companyId), async () => {
        const after = await vatDisplayedDiffersFromPosted(ctxOf(companyId, 20));
        expect(after).toMatchObject({ id: 'vat_displayed_differs_from_posted', count: 0, amount: 0, sample: [] });
      });
    });
  });
});

describe('vat_displayed_differs_from_posted: a tenant the planner has never seen', () => {
  afterAll(async () => {
    // The ANALYZEs below write pg_class's reltuples/relpages in place, so ROLLBACK does not undo them, and the rolled-back
    // seed leaves dead tuples that make an ANALYZE record 0 rows on N pages: later suites would then plan their fresh rows
    // as none. VACUUM drops the dead pages and records the counts true (same as bank-transfers-match-plan.int.test.ts).
    // VACUUM cannot run in a transaction block, so it goes through the pool, not the test's client.
    await getPoolForTests().query(
      'VACUUM (ANALYZE) bank_transactions, gl_journal_lines, gl_journal_entries, gl_accounts, company_users, companies',
    );
  }, 120_000);

  it('finishes in seconds as the app role under row-level security', async () => {
    await withTx(async (client) => {
      // Decoy tenants first, then ANALYZE (pg_statistic rolls back; pg_class does not: see afterAll), so statistics
      // exist for the tables but know nothing about the company seeded after.
      for (let i = 0; i < 3; i++) await seedUnseenTenant(client, `VAT plan decoy ${i}`);
      await client.query('ANALYZE bank_transactions');
      await client.query('ANALYZE gl_journal_lines');
      await client.query('ANALYZE gl_accounts');
      const { companyId, expected } = await seedUnseenTenant(client, 'VAT plan unseen tenant');
      await client.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')`, [companyId, USER]);

      await client.query(`SET LOCAL statement_timeout = '20s'`);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER, role: 'authenticated', company_id: companyId })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);

      await als.run(ctxFor(client, companyId), async () => {
        // The signal is the 20 s statement_timeout above: the old query is cancelled by it, this one answers in milliseconds.
        const result = await vatDisplayedDiffersFromPosted(ctxOf(companyId, 20));
        expect(result.count).toBe(expected);
        expect(result.sample).toHaveLength(20);
      });
    });
  }, 60_000);
});
