// D5 round 2: once default revenue and cost of sales sit on headers (allowed by Hein's 2026-10-02 ruling), the
// automatic postings that resolve those roles still post, ONTO the header, and the income statement shows them —
// the income statement has no header filter (isReportVisibleLeaf), so nothing is hidden. Roles are moved by the
// production Default Accounts save; the postings run through the production services. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, withTransaction } from '@/lib/neon';
import { saveDefaultAccountMappings } from '@/modules/accounting/services/gl/defaultAccountsService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
const ids: Record<string, string> = {};

/** An unflagged account, optionally under `parent`. */
async function account(code: string, type: string, subtype: string, level: number, parent?: string): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, is_active, is_system_account, level, parent_account_id)
    VALUES (${fx.companyId}::UUID, ${code}, ${`D5 ${code}`}, ${type}, ${subtype},
      ${type === 'expense' ? 'debit' : 'credit'}, true, false, ${level}, ${parent ?? null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
}

/** The account codes a journal's lines landed on, with their amounts. */
const linesOf = async (journalId: string) => (await sql`
  SELECT a.account_code, l.debit::FLOAT AS debit, l.credit::FLOAT AS credit
  FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
  WHERE l.journal_entry_id = ${journalId}::UUID ORDER BY a.account_code`) as Row[];

describeIfDb('D5: automatic postings through an income-statement role held by a header', () => {
  beforeAll(async () => {
    assertDisposable();
    fx = await seedFixture('W228D5P', DATABASE_URL!);
    // The fixture's 6000 holds cost of sales (default_expense); default revenue has no holder yet.
    ids.salesHeader = await account('4000', 'revenue', 'other', 1);
    await account('4010', 'revenue', 'revenue', 2, ids.salesHeader);
    ids.cosHeader = await account('5000', 'expense', 'other', 1);
    await account('5010', 'expense', 'operating_expense', 2, ids.cosHeader);
    const expense = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
      AND account_subtype = 'default_expense'`) as Row[])[0]!.id);
    await inTx(fx, () => withTransaction((tx) => saveDefaultAccountMappings(tx, fx.companyId,
      { sales_revenue: ids.salesHeader, cost_of_sales: ids.cosHeader }, { sales_revenue: null, cost_of_sales: expense })));
    clearSystemAccountCache(fx.companyId);
  });
  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${fx.companyId}::UUID)`;
    await dropFixture(fx);
  });

  it('the save put both roles on the headers', async () => {
    const holders = (await sql`SELECT account_subtype, account_code FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
      AND is_system_account AND account_subtype IN ('default_revenue', 'default_expense') ORDER BY account_subtype`) as Row[];
    expect(holders).toEqual([{ account_subtype: 'default_expense', account_code: '5000' }, { account_subtype: 'default_revenue', account_code: '4000' }]);
  });

  it('a customer invoice posts its revenue onto the revenue header, and the income statement shows it there', async () => {
    const invoice = await seedInvoice(fx, { number: 'D5-INV', date: '2026-06-20', total: 100 });
    const journal = await inTx(fx, () => postCustomerInvoiceToGL(fx.companyId, invoice, fx.userId));
    expect(await linesOf(journal)).toEqual([
      { account_code: '1100', debit: 100, credit: 0 },
      { account_code: '4000', debit: 0, credit: 100 },
    ]);
    const report = await getIncomeStatement(fx.companyId, '2026-01-01', '2026-12-31');
    expect({ line: report.revenue.find((l) => l.accountCode === '4000')?.amount, total: report.totalRevenue }).toEqual({ line: 100, total: 100 });
  });

  it('a supplier invoice line with no account posts onto the cost-of-sales header, and the income statement shows it there', async () => {
    const bill = await seedBill(fx, { number: 'D5-BILL', date: '2026-06-21', total: 40, status: 'draft' });
    await sql`INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, line_total)
      VALUES (${bill}::UUID, 'Uncoded line', 1, 40, 0, 40)`;
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill, fx.userId));
    const journal = String(((await sql`SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill}::UUID`) as Row[])[0]!.gl_journal_entry_id);
    expect(await linesOf(journal)).toEqual([
      { account_code: '2100', debit: 0, credit: 40 },
      { account_code: '5000', debit: 40, credit: 0 },
    ]);
    const report = await getIncomeStatement(fx.companyId, '2026-01-01', '2026-12-31');
    const expenseLines = [...report.costOfSales, ...report.operatingExpenses, ...report.otherExpenses];
    expect(expenseLines.filter((l) => l.accountCode === '5000').map((l) => l.amount)).toEqual([40]);
  });
});
