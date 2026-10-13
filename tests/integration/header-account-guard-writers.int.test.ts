/**
 * The writers that do not go through createJournalEntry's front door, or answer a refusal on their own route
 * (gl/headerAccountGuard): recurring journals, recurring transactions, a bank allocation, asset depreciation
 * and the year-end close. Each refuses a line on a balance-sheet header BEFORE its first write, and posts
 * normally once the header is gone / the line is on a leaf.
 * (createJournalEntry, reversal, reclassification, the journal route: header-account-guard.int.test.ts.)
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { postAssetDepreciationToGL } from '@/modules/accounting/services/gl/assetDepreciationPosting';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndCloseService';
import { createRecurringTemplate } from '@/modules/accounting/services/core/recurringTransactionService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { countRows } from './helpers/vatLateClaimFixture';
import { callRoute, dataOf } from './helpers/vatLateClaimRoutes';
import { addAccount, dropHeaderFixture, seedHeaderFixture, type HeaderFixture } from './helpers/headerGuardFixture';
import recurringJournalsAction from '../../pages/api/accounting/recurring-journals-action';
import recurringTransactionsExecute from '../../pages/api/accounting/recurring-transactions-execute';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
const HEADER_TEXT = 'is a header with sub-accounts; post to one of them.';
let h: HeaderFixture;

const lines = (account: string) => [
  { glAccountId: account, debit: 100, credit: 0, description: 'HG DR' },
  { glAccountId: h.fx.bankAccountId, debit: 0, credit: 100, description: 'HG CR' },
];

describeIfDb('every other writer refuses a line on a balance-sheet header before it writes', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HGW', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropHeaderFixture(h); }, 120000);

  describe('recurring journal: POST recurring-journals-action generate', () => {
    // 2023 is a CLOSED fiscal year: a run that reached the period guard first would answer "period is closed", so
    // the header refusal being the answer proves it is asked before the period guard and the claim.
    const template = async (account: string, nextRun: string) => String(((await sql`
      INSERT INTO recurring_journals (company_id, template_name, description, frequency, next_run_date, lines,
                                      total_amount, created_by, status)
      VALUES (${h.fx.companyId}::UUID, 'HG monthly', 'HG monthly', 'monthly', ${nextRun}::DATE,
              ${JSON.stringify(lines(account))}::JSONB, 100, ${h.fx.userId}, 'active')
      RETURNING id`) as Row[])[0]!.id);
    const state = async (id: string) => (await sql`
      SELECT run_count::INT AS run_count, next_run_date::TEXT AS next_run_date FROM recurring_journals WHERE id = ${id}::UUID`)[0] as Row;

    it('answers 400 with the message, ahead of the period guard; the schedule does not advance and no journal is written', async () => {
      await sql`
        INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
        VALUES (${h.fx.companyId}::UUID, ${`FY23 ${h.fx.tag}`}, 1, 2023, '2023-01-01', '2023-12-31', 'closed')`;
      const id = await template(h.assetHdr.id, '2023-03-01');
      const before = await countRows(h.fx);
      const refused = await callRoute(h.fx, h.token, recurringJournalsAction, { action: 'generate', id });
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(`Line 1: ${h.assetHdr.code} `);
      expect(JSON.stringify(refused.body)).toContain(HEADER_TEXT);
      expect(await state(id)).toEqual({ run_count: 0, next_run_date: '2023-03-01' });
      expect(await countRows(h.fx)).toEqual(before);
    });

    it('the same template on a leaf generates and advances', async () => {
      const id = await template(h.leaf, '2024-03-01');
      const ok = await callRoute(h.fx, h.token, recurringJournalsAction, { action: 'generate', id });
      expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
      expect(await state(id)).toEqual({ run_count: 1, next_run_date: '2024-04-01' });
    });
  });

  describe('recurring transaction: POST recurring-transactions-execute', () => {
    const journalTemplate = (account: string) => createRecurringTemplate(h.fx.companyId, h.fx.userId, {
      name: 'HG recurring journal', entityType: 'journal_entry', frequency: 'monthly', nextRunDate: '2026-07-01',
      templateData: { description: 'HG recurring', lines: lines(account) },
    });
    const nextRun = async (id: string) => String(((await sql`
      SELECT next_run_date::TEXT AS d FROM recurring_transaction_templates WHERE id = ${id}::UUID`) as Row[])[0]!.d);

    it('answers 400 for a journal template on a header; nothing is written and the schedule stays', async () => {
      const t = await journalTemplate(h.liabHdr.id);
      const before = await countRows(h.fx);
      const refused = await callRoute(h.fx, h.token, recurringTransactionsExecute, { templateId: t.id });
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(`Line 1: ${h.liabHdr.code} `);
      expect(JSON.stringify(refused.body)).toContain(HEADER_TEXT);
      expect(await countRows(h.fx)).toEqual(before);
      expect(await nextRun(t.id)).toBe('2026-07-01');
    });

    it('the same template on a leaf executes', async () => {
      const t = await journalTemplate(h.leaf);
      const ok = await callRoute(h.fx, h.token, recurringTransactionsExecute, { templateId: t.id });
      expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
      expect(await nextRun(t.id)).not.toBe('2026-07-01');
    });
  });

  it('bank allocation to an account that is a header: 400 with the message, the line stays unallocated, no journal', async () => {
    const bankTx = await seedBankTx(h.fx, { date: '2026-07-10', amount: -115, description: 'HG HEADER ALLOC' });
    const before = await countRows(h.fx);
    const refused = await callRoute(h.fx, h.token, bankTransactionsAction,
      { action: 'allocate', bankTransactionId: bankTx, allocationType: 'account', contraAccountId: h.assetHdr.id });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(`${h.assetHdr.code} `);
    expect(JSON.stringify(refused.body)).toContain(HEADER_TEXT);
    expect(await countRows(h.fx)).toEqual(before);
    const [row] = (await sql`SELECT status FROM bank_transactions WHERE id = ${bankTx}::UUID`) as Row[];
    expect(row!.status).toBe('imported');

    const okTx = await seedBankTx(h.fx, { date: '2026-07-10', amount: -115, description: 'HG LEAF ALLOC' });
    const ok = await callRoute(h.fx, h.token, bankTransactionsAction,
      { action: 'allocate', bankTransactionId: okTx, allocationType: 'account', contraAccountId: h.fx.expenseId });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(dataOf(ok)).toBeDefined();
  });

  it('asset depreciation with a header accumulated-depreciation account posts nothing; without the child it posts', async () => {
    const fx = h.fx;
    await addAccount(fx, { code: 'HG-DEPX', type: 'expense', level: 1, subtype: 'depreciation_expense', system: true });
    const accum = await addAccount(fx, { code: 'HG-ACCD', type: 'asset', level: 1, subtype: 'accumulated_depreciation', system: true });
    const child = await addAccount(fx, { code: 'HG-ACCD.1', type: 'asset', level: 2, parentId: accum });
    const asset = String(((await sql`
      INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years)
      VALUES (${fx.companyId}::UUID, ${`HGA-${fx.tag}`}, 'Laptop', '2026-01-01', 1200, 3)
      RETURNING id`) as Row[])[0]!.id);
    const before = await countRows(fx);
    expect(await inTx(fx, () => postAssetDepreciationToGL(fx.companyId, asset, 33.33, fx.userId))).toBeNull();
    expect(await countRows(fx)).toEqual(before);
    const [book] = (await sql`SELECT COALESCE(accumulated_depreciation, 0)::FLOAT8 AS acc FROM assets WHERE id = ${asset}::UUID`) as Row[];
    expect(book!.acc).toBe(0);

    await sql`DELETE FROM gl_accounts WHERE id = ${child}::UUID`;
    const entryId = await inTx(fx, () => postAssetDepreciationToGL(fx.companyId, asset, 33.33, fx.userId));
    expect(entryId).toEqual(expect.any(String));
  });

  it('year-end close with a header retained-earnings account is refused and writes nothing; without the child it closes', async () => {
    const fx = h.fx;
    const year = '2025';
    await sql`UPDATE companies SET financial_year_start = 1 WHERE id = ${fx.companyId}::UUID`;
    const re = await addAccount(fx, { code: 'HG-RE', type: 'equity', level: 1, subtype: 'retained_earnings', system: true });
    const child = await addAccount(fx, { code: 'HG-RE.1', type: 'equity', level: 2, parentId: re });
    const revenue = await addAccount(fx, { code: 'HG-REV25', type: 'revenue', level: 3 });
    const period = String(((await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`FY25 ${fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'closed')
      RETURNING id`) as Row[])[0]!.id);
    const sale = String(((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, fiscal_period_id, description, source, status,
                                      created_by, posted_by, posted_at)
      VALUES (${fx.companyId}::UUID, ${`HG-SALE-${fx.tag}`.slice(0, 40)}, '2025-06-30', ${period}::UUID, 'HG sale', 'manual', 'posted',
              ${fx.userId}, ${fx.userId}, NOW())
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id) VALUES
        (${sale}::UUID, ${fx.bankAccountId}::UUID, 1000, 0, 'HG sale', ${fx.companyId}::UUID),
        (${sale}::UUID, ${revenue}::UUID, 0, 1000, 'HG sale', ${fx.companyId}::UUID)`;
    const closed = async () => Number((((await sql`
      SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID AND source = 'year_end'`) as Row[])[0]!).n);
    const locked = async () => Number((((await sql`
      SELECT COUNT(*)::INT AS n FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID AND fiscal_year = 2025 AND status = 'locked'`) as Row[])[0]!).n);

    const before = await countRows(fx);
    const refused = await closeFiscalYear(fx.companyId, year, fx.userId).then(() => null, (e: unknown) => e);
    expect((refused as Error | null)?.message ?? '', 'the close was not refused').toContain(HEADER_TEXT);
    expect((refused as { code?: string }).code).toBe('HEADER_ACCOUNT_REFUSED');
    expect(await countRows(fx)).toEqual(before);
    expect(await closed()).toBe(0);
    expect(await locked()).toBe(0);

    await sql`DELETE FROM gl_accounts WHERE id = ${child}::UUID`;
    const result = await closeFiscalYear(fx.companyId, year, fx.userId) as { closingEntry: { id: string } | null };
    expect(result.closingEntry?.id).toEqual(expect.any(String));
    expect(await closed()).toBe(1);
    expect(await locked()).toBe(1);
  });
});
