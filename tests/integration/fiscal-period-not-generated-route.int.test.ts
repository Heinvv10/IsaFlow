/**
 * A journal dated in a gap of a fiscal year that already holds a closed period
 * reaches the person as a 400 naming the date, not as a posting with no period.
 *
 * The generator adds no month beside closed periods (migration 942), so
 * ensureFiscalPeriodForDate cannot cover the date. It used to return null, and
 * createJournalEntry stored fiscal_period_id NULL — a journal outside every
 * period-bounded report that postJournalEntry's closed-period check skips. It
 * now throws FiscalPeriodNotGeneratedError, an IS-A ClosedFiscalPeriodError, so
 * a route that answers a closed period with a 400 answers this one too. The
 * manual bank line route is that path here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import manualTx from '../../pages/api/accounting/bank-transactions-manual';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedFiscalYears } from './helpers/fiscalYearSeed';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const GAP_DAY = '2025-06-15';
let fx: Fixture;
let token = '';
let expense = '';

const count = async (query: Promise<unknown>) => Number(((await query) as { n: number }[])[0]!.n);

describeIfDb('a journal in a gap beside closed periods is refused as a 400', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('FPNG', DATABASE_URL!);
    token = await seedRouteUser(fx, 'fpng');
    expense = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
      AND account_code = '6000'`) as Record<string, unknown>[])[0]!.id);
    // FY2026 (March start): every month generated, March closed, June removed.
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM fiscal_years WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE companies SET financial_year_start = 3 WHERE id = ${fx.companyId}::UUID`;
    await seedFiscalYears(fx.companyId, GAP_DAY, GAP_DAY);
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${fx.companyId}::UUID AND start_date = '2025-03-01'`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID AND start_date = '2025-06-01'`;
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(fx);
    await dropFixture(fx);
  }, 60000);

  it('answers 400 with the date and the closed periods as the reason; writes nothing', async () => {
    const out = await callRoute(fx, token, manualTx, {
      type: 'spend', bankAccountId: fx.bankAccountId, date: GAP_DAY, amount: 10,
      description: 'FPNG manual', allocationType: 'account', contraAccountId: expense,
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body))
      .toMatch(/No fiscal period covers 2025-06-15.*FY2026 already holds closed or locked periods/);

    expect(await count(sql`SELECT COUNT(*)::int AS n FROM bank_transactions
      WHERE company_id = ${fx.companyId}::UUID AND description LIKE 'FPNG manual%'`)).toBe(0);
    expect(await count(sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${fx.companyId}::UUID`)).toBe(0);
    expect(await count(sql`SELECT COUNT(*)::int AS n FROM fiscal_periods
      WHERE company_id = ${fx.companyId}::UUID AND start_date = '2025-06-01'`)).toBe(0);
  }, 60000);
});
