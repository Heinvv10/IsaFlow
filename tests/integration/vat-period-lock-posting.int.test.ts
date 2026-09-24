/**
 * A locked VAT period refuses every posting that would move a VAT-return
 * figure, on every path that posts — and lets through a journal that moves
 * none.
 *
 * A lock means "this VAT201 is filed". Until the central guard, only the
 * supplier cancel plan and the reclassification guards read it; every other
 * path posted straight into a filed period. Each case below goes through the
 * real service a user or agent reaches, against isaflow_dev.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { postJournalTool } from '@/lib/mcp/tools/writeJournals';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postAssetDepreciationToGL } from '@/modules/accounting/services/gl/assetDepreciationPosting';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
const acc: Record<string, string> = {};
let seq = 0;

async function accountBySubtype(subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype}
    LIMIT 1`) as Row[])[0]!.id);
}

async function addAccount(code: string, type: string, subtype: string, normal: string): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)
    RETURNING id`) as Row[])[0]!.id);
}

/** The filed period every case posts into: May–June 2026. */
async function lockMayJune(): Promise<void> {
  await sql`
    INSERT INTO vat_period_locks
      (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
    VALUES (${fx.companyId}::UUID, '2026-05-01', '2026-06-30', 0, 0, 0, '2026-06-30', ${fx.userId})`;
}

type DraftLine = { glAccountId: string; debit: number; credit: number; vatType?: string };
const draftInput = (date: string, lines: DraftLine[]) => ({
  entryDate: date, description: `VL ${++seq}`, source: 'manual' as const,
  lines: lines.map((l) => ({ ...l, vatType: l.vatType as never })),
});

/**
 * A draft dated inside the lock. createJournalEntry refuses a VAT-moving one
 * outright, so the VAT drafts here are created on 2026-07-10 and then re-dated
 * into the lock — a draft that predates the lock, or whose date was edited
 * afterwards: the case the POST-time guard is the last line against.
 */
async function draftJournal(lines: DraftLine[]) {
  const je = await inTx(fx, () => createJournalEntry(fx.companyId, draftInput('2026-07-10', lines), fx.userId));
  await sql`UPDATE gl_journal_entries SET entry_date = '2026-06-10' WHERE id = ${je.id}::UUID`;
  return je;
}

const statusOf = async (id: string) => String(((await sql`
  SELECT status FROM gl_journal_entries WHERE id = ${id}::UUID`) as Row[])[0]!.status);

const vatJournalLines = () => [
  { glAccountId: acc.expense!, debit: 100, credit: 0 },
  { glAccountId: acc.vatInput!, debit: 15, credit: 0, vatType: 'standard' },
  { glAccountId: acc.ap!, debit: 0, credit: 115 },
];

describeIfDb('a locked VAT period refuses every posting that moves a VAT figure', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals into a locked VAT period.');
    fx = await seedFixture('VLP', DATABASE_URL!);
    acc.expense = await accountBySubtype('default_expense');
    acc.vatInput = await accountBySubtype('vat_input');
    acc.ap = await accountBySubtype('payable');
    acc.bank = fx.bankAccountId;
    await addAccount('4000', 'revenue', 'default_revenue', 'credit');
    await addAccount('6800', 'expense', 'depreciation_expense', 'debit');
    await addAccount('1590', 'asset', 'accumulated_depreciation', 'credit');
    clearSystemAccountCache(fx.companyId);
    await lockMayJune();
  }, 120000);

  afterAll(async () => {
    const c = fx.companyId;
    clearSystemAccountCache(c);
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM approval_requests WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_coding_history WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM assets WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses a manual journal carrying VAT (postJournalEntry) and leaves it a draft', async () => {
    const je = await draftJournal(vatJournalLines());
    const err = await inTx(fx, () => postJournalEntry(fx.companyId, je.id, fx.userId)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect((err as Error).message).toContain('2026-05-01 to 2026-06-30');
    expect(await statusOf(je.id)).toBe('draft');
  });

  it('createJournalEntry refuses a VAT-moving draft dated in the lock before inserting anything', async () => {
    const before = ((await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n;
    await expect(inTx(fx, () => createJournalEntry(fx.companyId, draftInput('2026-06-10', vatJournalLines()), fx.userId)))
      .rejects.toBeInstanceOf(VatPeriodLockedError);
    const after = ((await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n;
    expect(after).toBe(before);
  });

  it('refuses post_journal over MCP with a refusal the registry surfaces verbatim', async () => {
    const je = await draftJournal(vatJournalLines());
    const ctx = { companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti-vl', scopes: [] } as unknown as McpToolContext;
    const err = await inTx(fx, () => postJournalTool.handler({ journal_id: je.id, idempotency_key: `k${++seq}` }, ctx))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect(isRefusalCoded(err)).toBe(true);
    expect(await statusOf(je.id)).toBe('draft');
  });

  it('ALLOWS a journal with no VAT line inside the locked period', async () => {
    const je = await draftJournal([
      { glAccountId: acc.expense!, debit: 50, credit: 0, vatType: 'no_vat' },
      { glAccountId: acc.bank!, debit: 0, credit: 50 },
    ]);
    await inTx(fx, () => postJournalEntry(fx.companyId, je.id, fx.userId));
    expect(await statusOf(je.id)).toBe('posted');
  });

  it('refuses approving a supplier bill dated in the period, leaving it a draft with no journal', async () => {
    const bill = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
      supplierId: fx.supplierId, invoiceNumber: `VLB-${fx.tag}`.slice(0, 50), invoiceDate: '2026-06-12',
      items: [{ description: 'Stock', quantity: 1, unitPrice: 100, taxRate: 15, glAccountId: acc.expense }],
    }, fx.userId));
    await expect(inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId)))
      .rejects.toBeInstanceOf(VatPeriodLockedError);
    const row = ((await sql`SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[])[0]!;
    expect(row).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });

  it('refuses a bank allocation that splits out VAT, and allows the same line with none', async () => {
    const withVat = await seedBankTx(fx, { date: '2026-06-15', amount: -115, description: 'VAT spend' });
    await expect(inTx(fx, () => allocateTransaction(
      fx.companyId, withVat, acc.expense!, fx.userId, undefined, 'account', undefined, 'standard',
    ))).rejects.toBeInstanceOf(VatPeriodLockedError);
    const st = ((await sql`SELECT status FROM bank_transactions WHERE id = ${withVat}::UUID`) as Row[])[0]!;
    expect(st.status).toBe('imported');

    const noVat = await seedBankTx(fx, { date: '2026-06-15', amount: -40, description: 'No VAT spend' });
    const out = await inTx(fx, () => allocateTransaction(
      fx.companyId, noVat, acc.expense!, fx.userId, undefined, 'account', undefined, 'no_vat',
    ));
    expect(await statusOf(out.journalEntryId)).toBe('posted');
  });

  it('refuses the AR historical import of an invoice carrying output VAT', async () => {
    const inv = String(((await sql`
      INSERT INTO customer_invoices
        (company_id, customer_id, client_id, invoice_number, invoice_date, due_date,
         subtotal, tax_amount, total_amount, amount_paid, status, created_by)
      VALUES (${fx.companyId}::UUID, ${fx.customerId}::UUID, ${fx.customerId}::UUID, ${`VLI-${fx.tag}`},
              '2026-06-20', '2026-06-20', 100, 15, 115, 0, 'sent', ${fx.userId}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    await expect(inTx(fx, () => postCustomerInvoiceToGL(fx.companyId, inv, fx.userId, { historicalImport: true })))
      .rejects.toBeInstanceOf(VatPeriodLockedError);
    const posted = (await sql`
      SELECT 1 FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID
        AND source = 'auto_invoice'`) as Row[];
    expect(posted).toHaveLength(0);
  });

  /** Depreciation cannot carry a VAT line: its two accounts are resolved BY
   *  subtype `depreciation_expense` / `accumulated_depreciation` (never VAT
   *  class) and it writes no vat_type. So inside a lock it must still post. */
  it('lets depreciation post inside a locked period, because it cannot move a VAT figure', async () => {
    const today = new Date();
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, ${iso(new Date(today.getFullYear(), today.getMonth(), 1))}::DATE,
              ${iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))}::DATE, 0, 0, 0, NOW(), ${fx.userId})`;
    const asset = String(((await sql`
      INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years)
      VALUES (${fx.companyId}::UUID, ${`VLA-${fx.tag}`}, 'Laptop', '2026-01-01', 1200, 3)
      RETURNING id`) as Row[])[0]!.id);
    const entryId = await inTx(fx, () => postAssetDepreciationToGL(fx.companyId, asset, 33.33, fx.userId));
    expect(entryId).not.toBeNull();
    expect(await statusOf(entryId!)).toBe('posted');
  });
});
