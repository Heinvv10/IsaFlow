/**
 * NUMRACE round 3 (sec-numrace S2): a tenant-supplied ledger date must be an ISO day from 1900-01-01 to 2199-12-31.
 *
 * Postgres takes 5- to 7-digit years, and the round-2 year count read only the first four digits, so a GL import of
 * 2000 groups dated 100000..101999 passed the 20-year cap as two years, posted all 2000 journals and held 2021
 * advisory locks. Now the import refuses those dates (400, nothing written) and journalYearOf counts the year the
 * trigger does. The bank routes that take a date refuse it too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import glImport from '../../pages/api/accounting/gl-import';
import manualTx from '../../pages/api/accounting/bank-transactions-manual';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { dropCrossYear, seedCrossYear, type CrossYear } from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: CrossYear;
let token = '';

const groups = (years: number[], tag: string) => years.flatMap((y) => [
  { date: `${y}-01-01`, reference: `${tag}-${y}`, accountCode: '6000', description: tag, debit: 1, credit: 0 },
  { date: `${y}-01-01`, reference: `${tag}-${y}`, accountCode: '1000', description: tag, debit: 0, credit: 1 },
]);
const written = async (tag: string) => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE ${`${tag}-%`}`) as { n: number }[])[0]!.n);

describeIfDb('NUMRACE r3: ledger dates outside 1900..2199 are refused', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedCrossYear('NUMRACE-DW', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-dw');
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(c.fx);
    await dropCrossYear(c);
    await dropFixture(c.fx);
  }, 60000);

  it("sec's GL import, 2000 groups dated 100000..101999: 400 before anything is written", async () => {
    const years = Array.from({ length: 2000 }, (_, i) => 100000 + i);
    const out = await callRoute(c.fx, token, glImport, { rows: groups(years, 'NRDW'), postImmediately: true });
    process.stdout.write(`DW-2000 ${JSON.stringify({ status: out.statusCode, body: out.body, written: await written('NRDW') })}\n`);
    expect(out.statusCode, JSON.stringify(out.body).slice(0, 300)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/expected YYYY-MM-DD|outside 1900-01-01 to 2199-12-31/);
    expect(await written('NRDW')).toBe(0);
  }, 300000);

  it('two groups in 5-digit years (under the cap): still refused by the window', async () => {
    const out = await callRoute(c.fx, token, glImport, { rows: groups([100000, 100001], 'NRDW2'), postImmediately: true });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/expected YYYY-MM-DD|outside 1900-01-01 to 2199-12-31/);
    expect(await written('NRDW2')).toBe(0);
  }, 120000);

  it('a manual bank line dated 0001-06-01: refused (422 validation), nothing written', async () => {
    const out = await callRoute(c.fx, token, manualTx, {
      type: 'spend', bankAccountId: c.fx.bankAccountId, date: '0001-06-01', amount: 10,
      description: 'NRDW manual', allocationType: 'account', contraAccountId: c.expense,
    });
    const n = (await sql`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID
      AND description LIKE 'NRDW manual%'`) as { n: number }[];
    expect(out.statusCode, JSON.stringify(out.body)).toBe(422);
    expect(JSON.stringify(out.body)).toMatch(/between 1900-01-01 and 2199-12-31/);
    expect(n[0]!.n).toBe(0);
  }, 60000);
});
