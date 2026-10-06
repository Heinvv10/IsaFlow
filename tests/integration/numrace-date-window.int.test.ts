/**
 * Ledger-date window (sec-numrace S2): a tenant-supplied ledger date must be a day from 1900-01-01 to 2199-12-31.
 *
 * Postgres takes 5- to 7-digit years, and each journal year is its own journal-number key (migration 857): a GL import
 * of 2000 groups dated 100000..101999 posted 2000 journals and held 2000+ advisory locks in the cluster-wide lock
 * table. The import now refuses those dates (400, nothing written), as do the bank routes that take a date. The forms
 * the import took before the window (an ISO timestamp, blind review LOW 3) still pass, as the day they name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import glImport from '../../pages/api/accounting/gl-import';
import manualTx from '../../pages/api/accounting/bank-transactions-manual';
import classifiedTx from '../../pages/api/accounting/bank-transactions-import-classified';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: DateFixture;
let token = '';

const groups = (years: number[], tag: string) => years.flatMap((y) => [
  { date: `${y}-01-01`, reference: `${tag}-${y}`, accountCode: '6000', description: tag, debit: 1, credit: 0 },
  { date: `${y}-01-01`, reference: `${tag}-${y}`, accountCode: '1000', description: tag, debit: 0, credit: 1 },
]);
const written = async (tag: string) => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE ${`${tag}-%`}`) as { n: number }[])[0]!.n);

describeIfDb('ledger dates outside 1900..2199 are refused; every form base took still imports', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('NUMRACE-DW', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-dw');
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(c.fx);
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
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(n[0]!.n).toBe(0);
  }, 60000);

  it('blind review LOW 3: a GL import dated 2025-03-31T00:00:00 (validated on base) posts on 2025-03-31', async () => {
    const rows = groups([2025], 'NRDWT').map((r) => ({ ...r, date: '2025-03-31T00:00:00' }));
    const out = await callRoute(c.fx, token, glImport, { rows, postImmediately: true });
    const jes = (await sql`SELECT entry_date::text AS d FROM gl_journal_entries
      WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE 'NRDWT-%'`) as { d: string }[];
    process.stdout.write(`DW-ts ${JSON.stringify({ status: out.statusCode, body: out.body, jes })}\n`);
    expect(out.statusCode, JSON.stringify(out.body).slice(0, 300)).toBe(200);
    expect(jes.map((j) => j.d)).toEqual(['2025-03-31']);
  }, 60000);

  it('blind review LOW 3: a manual bank line dated 2025-12-20T00:00:00 is stored on 2025-12-20', async () => {
    const out = await callRoute(c.fx, token, manualTx, {
      type: 'spend', bankAccountId: c.fx.bankAccountId, date: '2025-12-20T00:00:00', amount: 10,
      description: 'NRDWT manual', allocationType: 'account', contraAccountId: c.expense,
    });
    const rows = (await sql`SELECT transaction_date::text AS d FROM bank_transactions
      WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE 'NRDWT manual%'`) as { d: string }[];
    expect(out.statusCode, JSON.stringify(out.body).slice(0, 300)).toBeLessThan(300);
    expect(rows.map((r) => r.d)).toEqual(['2025-12-20']);
  }, 60000);

  // brk-numrace F1: forms base imported (JS Date and Postgres both read them) that the round-4 JS parser refused.
  const BRK_FORMS = ['2025-3-31', '31-Mar-2025', '2025.03.31', '03-31-2025', '3/31/25', '20250331',
    'Monday, March 31, 2025'];

  it('brk F1: a GL import in every form base took posts each group on 2025-03-31', async () => {
    const rows = BRK_FORMS.flatMap((f, i) => groups([2025], `NRDWF${i}`).map((r) => ({ ...r, date: f })));
    const out = await callRoute(c.fx, token, glImport, { rows, postImmediately: true });
    const jes = (await sql`SELECT entry_date::text AS d FROM gl_journal_entries
      WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE 'NRDWF%'`) as { d: string }[];
    process.stdout.write(`DW-forms ${JSON.stringify({ status: out.statusCode, body: out.body, jes })}\n`);
    expect(out.statusCode, JSON.stringify(out.body).slice(0, 300)).toBe(200);
    expect(jes.map((j) => j.d)).toEqual(BRK_FORMS.map(() => '2025-03-31'));
  }, 60000);

  it('brk F1: manual bank lines in those forms are stored on 2025-03-31', async () => {
    const statuses: Record<string, number> = {};
    const bankForms = BRK_FORMS.filter((f) => f.length >= 8); // the route's schema (base) wants 8+ characters
    for (const f of bankForms) {
      const out = await callRoute(c.fx, token, manualTx, {
        type: 'spend', bankAccountId: c.fx.bankAccountId, date: f, amount: 10,
        description: `NRDWF manual ${f}`, allocationType: 'account', contraAccountId: c.expense,
      });
      statuses[f] = out.statusCode;
    }
    const days = (await sql`SELECT transaction_date::text AS d FROM bank_transactions
      WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE 'NRDWF manual%'`) as { d: string }[];
    process.stdout.write(`DW-forms-manual ${JSON.stringify({ statuses, days })}\n`);
    expect(Object.values(statuses).every((st) => st < 300), JSON.stringify(statuses)).toBe(true);
    expect(days.map((d) => d.d)).toEqual(bankForms.map(() => '2025-03-31'));
  }, 60000);

  // The classified import's INSERT fails on this fixture's schema (suggested_cost_centre, before and after this
  // change), so its window is pinned at the refusal, which comes first: a base form passes it, 0001 does not.
  it('brk F1: the classified import refuses 0001-06-01 (422) and lets 2025-3-31 through its window', async () => {
    const send = (d: string) => callRoute(c.fx, token, classifiedTx, { bankAccountId: c.fx.bankAccountId,
      transactions: [{ transactionDate: d, description: `NRDWF classified ${d}`, debit: 3 }] });
    const [old, form] = [await send('0001-06-01'), await send('2025-3-31')];
    process.stdout.write(`DW-classified ${JSON.stringify({ old: old.body, form: form.body })}\n`);
    expect(old.statusCode).toBe(422);
    expect(JSON.stringify(old.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(form.statusCode).not.toBe(422);
  }, 60000);
});
