// tests/integration/financialFiguresScoping.int.test.ts
/**
 * Real-Postgres proof that the `gl_accounts` scoping fix in
 * financialFiguresService.ts and balanceSheetService.ts makes the no-RLS
 * share pack path and the RLS-authenticated page path agree.
 *
 * Brightsphere's JE-2026-00002 posts a R450 debit to account 1140, which
 * belongs to Dotbiz, not Brightsphere:
 *
 *   - The share pack (`sharedPackService` → `getFinancialFigures`) runs on
 *     the pool connection, a superuser that bypasses RLS.
 *   - The authenticated page (`getBalanceSheet`) runs under RLS as
 *     `app_user`.
 *
 * Before the fix these two paths disagreed by R450: unscoped, the pool path
 * classified the line through Dotbiz's account while RLS silently dropped it
 * from the join for the authenticated path. After the fix both paths exclude
 * the foreign leg for the same reason (`ga.company_id` no longer matches) and
 * report the same out-of-balance amount.
 *
 * Deliberately fails (not skips) without a real DATABASE_URL — same
 * convention as the other tests/integration/*.int.test.ts files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { getFinancialFigures, totalEquity } from '@/modules/accounting/services/gl/financialFiguresService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL || DATABASE_URL.includes('dummy')) {
  throw new Error('financialFiguresScoping requires a real DATABASE_URL; it does not skip');
}

const BRIGHTSPHERE = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const BRIGHTSPHERE_USER = 'f110ef4f-e388-442e-8428-1a265b8d0a6a'; // owner, per company_users
const FROM = '2026-03-01';
const TO = '2026-08-31';

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('dummy')) {
    throw new Error('financialFiguresScoping requires a real DATABASE_URL; it does not skip');
  }
});

afterAll(async () => {
  await getPoolForTests().end();
});

describe('getFinancialFigures vs getBalanceSheet — Brightsphere agree after scoping', () => {
  it('JE-2026-00002 really does carry a foreign-account leg (fixture assumption)', async () => {
    const rows = await sql<{ account_company_id: string; debit: string }>`
      SELECT ga.company_id AS account_company_id, jl.debit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.entry_number = 'JE-2026-00002'
        AND je.company_id = ${BRIGHTSPHERE}::UUID
        AND ga.company_id != ${BRIGHTSPHERE}::UUID
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.debit)).toBeCloseTo(450, 2);
    expect(rows[0]!.account_company_id).not.toBe(BRIGHTSPHERE);
  });

  it('the no-RLS pack path and the RLS-authenticated page path report the SAME out-of-balance amount', async () => {
    // Pack path: pool superuser, no RLS — exactly how sharedPackService reads.
    const figures = await getFinancialFigures(BRIGHTSPHERE, FROM, TO);
    const packAssets = figures.cumulative.totalAssets;
    const packLiabPlusEquity = figures.cumulative.totalLiabilities + totalEquity(figures);
    const packImbalance = packAssets - packLiabPlusEquity;

    // Authenticated path: RLS as app_user, GUCs set for Brightsphere.
    const pool = getPoolForTests();
    const client = await pool.connect();
    let report: Awaited<ReturnType<typeof getBalanceSheet>>;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: BRIGHTSPHERE_USER }),
      ]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [BRIGHTSPHERE]);

      report = await als.run(
        { client, userId: BRIGHTSPHERE_USER, companyId: BRIGHTSPHERE, claims: { sub: BRIGHTSPHERE_USER } },
        () => getBalanceSheet(BRIGHTSPHERE, TO)
      );
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const bsImbalance = report.totalAssets - (report.totalLiabilities + report.totalEquity);

    // Both paths now exclude the foreign leg for the same reason, so they
    // agree — the books still do not balance (a separate defect: the R450
    // debit's own two legs are otherwise fine), but by the SAME amount on
    // both paths, not two different wrong answers.
    expect(packImbalance).toBeCloseTo(bsImbalance, 2);
    expect(Math.abs(packImbalance)).toBeCloseTo(450, 2);
  });
});
