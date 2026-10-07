/**
 * Ledger-date window, round 7 (brk-numrace Y1): every route that reaches createJournalEntry with a stored or tenant
 * date answers a refusal 400 with nothing written — through lib/apiJournalDate.withJournalDateRefusal, or a check of
 * its own before its first write. One case per class of the census (agents/numrace-report.md, Round 7):
 *   - a tenant date on a single posting call (wrapped): POST /loans/:id/payments dated 2205-01-01;
 *   - a tenant reversal date on a stored journal (wrapped): journal-entries-action reverse to 2205-01-01 (a legacy
 *     2205 period, so it reaches the funnel; without one the route refuses earlier);
 *   - a tenant date the route writes with BEFORE its journal (checked first): asset dispose dated 2205-01-01.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import loanPayments from '../../pages/api/accounting/loans/[id]/payments';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import assetDispose from '../../pages/api/accounting/assets/[assetId]/dispose';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: DateFixture;
let token = '';
const count = async (q: Promise<unknown>) => Number(((await q) as { n: number }[])[0]!.n);
const journals = () => count(sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID AND entry_date > '2199-12-31'`);

describeIfDb('ledger-date window: the createJournalEntry route census', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('NUMRACE-JC', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-jc');
  }, 60000);
  afterAll(async () => {
    await sql`DELETE FROM loan_payments WHERE company_id = ${c.fx.companyId}::UUID`.catch(() => undefined);
    await sql`DELETE FROM loan_schedule_rows WHERE run_id IN (
      SELECT id FROM loan_schedule_runs WHERE company_id = ${c.fx.companyId}::UUID)`.catch(() => undefined);
    await sql`DELETE FROM loan_schedule_runs WHERE company_id = ${c.fx.companyId}::UUID`.catch(() => undefined);
    await sql`DELETE FROM loans WHERE company_id = ${c.fx.companyId}::UUID`.catch(() => undefined);
    await sql`DELETE FROM asset_period_ledger WHERE company_id = ${c.fx.companyId}::UUID`.catch(() => undefined);
    await sql`DELETE FROM assets WHERE company_id = ${c.fx.companyId}::UUID`.catch(() => undefined);
    await dropRouteUser(c.fx).catch(() => undefined);
    await dropFixture(c.fx).catch(() => undefined);
  }, 60000);

  it('brk Y1: a loan payment dated 2205-01-01 is a 400, nothing written', async () => {
    const loan = crypto.randomUUID();
    const run = crypto.randomUUID();
    await sql`INSERT INTO loans (id, company_id, reference, principal, start_date, term_months, rate_mode, fixed_rate,
        gl_account_id, interest_expense_account_id, bank_account_id, status)
      VALUES (${loan}::UUID, ${c.fx.companyId}::UUID, 'NRJC-LOAN', 1000, '2025-01-01', 12, 'FIXED', 12,
        ${c.expense}::UUID, ${c.expense}::UUID, ${c.fx.bankAccountId}::UUID, 'active')`;
    await sql`INSERT INTO loan_schedule_runs (id, loan_id, company_id, engine_version, inputs_hash)
      VALUES (${run}::UUID, ${loan}::UUID, ${c.fx.companyId}::UUID, 'test', 'nrjc')`;
    await sql`INSERT INTO loan_schedule_rows (run_id, period, date, opening, rate, installment, interest, principal,
        lump, skip_flag, payment, closing, st_liability, extrapolated, nca_flagged)
      VALUES (${run}::UUID, 1, '2025-02-01', 1000, 12, 1000, 100, 900, 0, false, 1000, 100, 0, false, false)`;
    const out = await callRoute(c.fx, token, loanPayments, { paymentDate: '2205-01-01', periodNumber: 1 }, { id: loan });
    const paid = await count(sql`SELECT COUNT(*)::int AS n FROM loan_payments WHERE loan_id = ${loan}::UUID`);
    process.stdout.write(`JC-loan ${JSON.stringify({ status: out.statusCode, body: out.body, paid })}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(paid).toBe(0);
    expect(await journals()).toBe(0);
  }, 60000);

  it('reversing a posted 2025 journal to 2205-01-01: a 400, the original still posted, no reversal', async () => {
    // A legacy 2205 period (created before the fiscal-year window), so the reversal reaches the funnel.
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${c.fx.companyId}::UUID, ${`FY2205 ${c.fx.tag}`}, 1, 2205, '2205-01-01', '2205-12-31', 'open')`;
    const je = await inTx(c.fx, async () => {
      const entry = await createJournalEntry(c.fx.companyId, { entryDate: '2025-06-01', description: 'NRJC rev', lines: [
        { glAccountId: c.expense, debit: 5, credit: 0, description: 'x' },
        { glAccountId: c.fx.bankAccountId, debit: 0, credit: 5, description: 'x' },
      ] }, c.fx.userId);
      await postJournalEntry(c.fx.companyId, entry.id, c.fx.userId);
      return entry.id;
    });
    const out = await callRoute(c.fx, token, journalEntriesAction, { id: je, action: 'reverse', reversal_date: '2205-01-01' });
    const st = (await sql`SELECT status FROM gl_journal_entries WHERE id = ${je}::UUID`) as { status: string }[];
    const reversals = await count(sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${je}::UUID`);
    process.stdout.write(`JC-reverse ${JSON.stringify({ status: out.statusCode, body: out.body, st, reversals })}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(st[0]!.status).toBe('posted');
    expect(reversals).toBe(0);
  }, 60000);

  it('disposing of an asset on 2205-01-01: a 400 before the ledger row and the disposal type are written', async () => {
    const asset = crypto.randomUUID();
    await sql`INSERT INTO assets (id, company_id, asset_number, name, purchase_date, purchase_price, useful_life_years,
        gl_asset_account_id, status)
      VALUES (${asset}::UUID, ${c.fx.companyId}::UUID, 'NRJC-A1', 'NRJC asset', '2025-01-01', 1000, 5, ${c.expense}::UUID,
        'available')`;
    const out = await callRoute(c.fx, token, assetDispose,
      { disposalDate: '2205-01-01', proceeds: 100, disposalType: 'sale' }, { assetId: asset });
    const ledger = await count(sql`SELECT COUNT(*)::int AS n FROM asset_period_ledger WHERE asset_id = ${asset}::UUID`);
    const row = (await sql`SELECT status, disposal_type FROM assets WHERE id = ${asset}::UUID`) as Record<string, unknown>[];
    process.stdout.write(`JC-dispose ${JSON.stringify({ status: out.statusCode, body: out.body, ledger, row })}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(ledger).toBe(0);
    expect(row[0]).toEqual({ status: 'available', disposal_type: null });
  }, 60000);
});
