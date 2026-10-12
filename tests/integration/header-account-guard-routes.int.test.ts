/**
 * Where a header refusal must reach the user as the right status, with nothing left behind (gl/headerAccountGuard,
 * PR #701 review round 1):
 *  - GL import: a header on a LATER group is a 400 naming its row, and group 1 is not written either;
 *  - year-end: a header retained-earnings account is a 400, no closing journal, no periods locked;
 *  - a customer_invoice auto-post template posts its journal AFTER the invoice INSERT, so the refusal there must be
 *    a 500 that rolls the invoice back (a 400 would be COMMITted with the invoice in it), and the schedule stays;
 *  - a NULL-level asset with a child is a header: the balance sheet's own `level >= 3` hides it too.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { HeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { countRows } from './helpers/vatLateClaimFixture';
import { callRoute } from './helpers/vatLateClaimRoutes';
import { addAccount, dropHeaderFixture, seedHeaderFixture, type HeaderFixture } from './helpers/headerGuardFixture';
import glImport from '../../pages/api/accounting/gl-import';
import yearEnd from '../../pages/api/accounting/year-end';
import recurringTransactionsExecute from '../../pages/api/accounting/recurring-transactions-execute';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
const HEADER_TEXT = 'is a header with sub-accounts; post to one of them.';
const DATE = '2026-07-10';
let h: HeaderFixture;

const count = async (query: Promise<unknown[]>): Promise<number> => Number(((await query) as Row[])[0]!.n);

describeIfDb('header refusals answer the right status and leave nothing behind', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HGX', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropHeaderFixture(h); }, 120000);

  it('GL import: a header on the SECOND group is a 400 naming that row, and group 1 is not written either', async () => {
    const row = (reference: string, description: string, accountCode: string, debit: number, credit: number) =>
      ({ date: DATE, reference, description, accountCode, debit, credit });
    const file = (secondGroupAccount: string) => ({
      postImmediately: true,
      rows: [
        row('HGX-1', 'group one expense', '6000', 50, 0), row('HGX-1', 'group one ap', '2100', 0, 50),
        row('HGX-2', 'group two expense', '6000', 70, 0), row('HGX-2', 'group two header', secondGroupAccount, 0, 70),
      ],
    });
    const before = await countRows(h.fx);
    const refused = await callRoute(h.fx, h.token, glImport, file(h.assetHdr.code));
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(`Import row \\"group two header\\" (${DATE}): ${h.assetHdr.code} `);
    expect(JSON.stringify(refused.body)).toContain(HEADER_TEXT);
    expect(await countRows(h.fx)).toEqual(before);

    const ok = await callRoute(h.fx, h.token, glImport, file('HG-LEAF'));
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect((await countRows(h.fx)).entries).toBe(before.entries + 2);
  });

  it('year-end close with a header retained-earnings account: 400 with the message, no closing journal, no period locked', async () => {
    const fx = h.fx;
    await sql`UPDATE companies SET financial_year_start = 1 WHERE id = ${fx.companyId}::UUID`;
    const re = await addAccount(fx, { code: 'HGX-RE', type: 'equity', level: 1, subtype: 'retained_earnings', system: true });
    await addAccount(fx, { code: 'HGX-RE.1', type: 'equity', level: 2, parentId: re });
    const revenue = await addAccount(fx, { code: 'HGX-REV25', type: 'revenue', level: 3 });
    const period = String(((await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`FY25 ${fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'closed')
      RETURNING id`) as Row[])[0]!.id);
    const sale = String(((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, fiscal_period_id, description, source, status,
                                      created_by, posted_by, posted_at)
      VALUES (${fx.companyId}::UUID, ${`HGX-SALE-${fx.tag}`.slice(0, 40)}, '2025-06-30', ${period}::UUID, 'HG sale', 'manual',
              'posted', ${fx.userId}, ${fx.userId}, NOW())
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id) VALUES
        (${sale}::UUID, ${fx.bankAccountId}::UUID, 1000, 0, 'HG sale', ${fx.companyId}::UUID),
        (${sale}::UUID, ${revenue}::UUID, 0, 1000, 'HG sale', ${fx.companyId}::UUID)`;

    const before = await countRows(fx);
    const refused = await callRoute(fx, h.token, yearEnd, { action: 'close', yearLabel: '2025' });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('HGX-RE ');
    expect(JSON.stringify(refused.body)).toContain(HEADER_TEXT);
    expect(await countRows(fx)).toEqual(before);
    expect(await count(sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries
      WHERE company_id = ${fx.companyId}::UUID AND source = 'year_end'`)).toBe(0);
    expect(await count(sql`SELECT COUNT(*)::INT AS n FROM fiscal_periods
      WHERE company_id = ${fx.companyId}::UUID AND fiscal_year = 2025 AND status = 'locked'`)).toBe(0);
  });

  it('customer_invoice auto-post template with a header AR account: 5xx, no invoice survives, the schedule stays', async () => {
    const fx = h.fx;
    const revenue = await addAccount(fx, { code: 'HGX-REVINV', type: 'revenue', level: 3, subtype: 'default_revenue', system: true });
    const [ar] = (await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'receivable'`) as Row[];
    await addAccount(fx, { code: 'HGX-AR.1', type: 'asset', level: 2, parentId: String(ar!.id) });
    const data = {
      clientId: fx.customerId, subtotal: 100, vatAmount: 15, totalAmount: 115,
      lines: [{ description: 'Retainer', quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, accountId: revenue }],
    };
    const templateId = String(((await sql`
      INSERT INTO recurring_transaction_templates (company_id, name, entity_type, template_data, frequency, next_run_date,
                                                   is_active, auto_post, created_by)
      VALUES (${fx.companyId}::UUID, 'HGX invoice', 'customer_invoice', ${JSON.stringify(data)}::JSONB, 'monthly',
              CURRENT_DATE, true, true, ${fx.userId})
      RETURNING id`) as Row[])[0]!.id);
    const invoices = () => count(sql`SELECT COUNT(*)::INT AS n FROM customer_invoices WHERE company_id = ${fx.companyId}::UUID`);
    const nextRun = async () => String(((await sql`
      SELECT next_run_date::TEXT AS d FROM recurring_transaction_templates WHERE id = ${templateId}::UUID`) as Row[])[0]!.d);
    const [due, before, invoicesBefore] = [await nextRun(), await countRows(fx), await invoices()];

    const refused = await callRoute(fx, h.token, recurringTransactionsExecute, { templateId });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(refused.body)).toContain(HEADER_TEXT);
    expect(await invoices()).toBe(invoicesBefore);
    expect(await countRows(fx)).toEqual(before);
    expect(await nextRun()).toBe(due);
  });

  it('a NULL-level asset account with a child is a header: createJournalEntry refuses it', async () => {
    const fx = h.fx;
    const acct = await addAccount(fx, { code: 'HGX-NULL', type: 'asset', level: 1 });
    await addAccount(fx, { code: 'HGX-NULL.1', type: 'asset', level: 2, parentId: acct });
    await sql`UPDATE gl_accounts SET level = NULL WHERE id = ${acct}::UUID`;
    const before = await countRows(fx);
    const err = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: DATE, description: 'HGX null level', source: 'manual',
      lines: [{ glAccountId: acct, debit: 100, credit: 0 }, { glAccountId: fx.bankAccountId, debit: 0, credit: 100 }],
    }, fx.userId)).then(() => null, (e: unknown) => e);
    expect(err, 'the journal was not refused').toBeInstanceOf(HeaderAccountRefusal);
    expect((err as HeaderAccountRefusal).message).toContain('Line 1: HGX-NULL ');
    expect(await countRows(fx)).toEqual(before);
  });
});
