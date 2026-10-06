/**
 * Ledger-date window: a fiscal year must lie inside 1900-01-01..2199-12-31 (createFiscalYear). Its periods date the
 * journals no createJournalEntry check sees — the year-end closing journal is dated the year's last day, a
 * depreciation run its period — and POST fiscal-periods took any number as a year (1, 1899, 2200 and 100000 each
 * created twelve periods).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import fiscalPeriods from '../../pages/api/accounting/fiscal-periods';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: DateFixture;
let token = '';

const periodsOf = async (year: number) => Number(((await sql`SELECT COUNT(*)::int AS n FROM fiscal_periods
  WHERE company_id = ${c.fx.companyId}::UUID AND fiscal_year = ${year}`) as { n: number }[])[0]!.n);

describeIfDb('ledger-date window: fiscal years', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('NUMRACE-FY', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-fy');
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(c.fx);
    await dropFixture(c.fx);
  }, 60000);

  it.each([1, 1899, 2200, 100000, 21990])('POST fiscal-periods year %i: 400, no period created', async (year) => {
    const out = await callRoute(c.fx, token, fiscalPeriods, { year });
    process.stdout.write(`FY-${year} ${JSON.stringify({ status: out.statusCode, body: out.body }).slice(0, 300)}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await periodsOf(year)).toBe(0);
  }, 60000);

  it('a year inside the window (2199) is still created', async () => {
    const out = await callRoute(c.fx, token, fiscalPeriods, { year: 2199 });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await periodsOf(2199)).toBe(12);
  }, 60000);
});
