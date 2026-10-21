/**
 * A supplier-bill line may only name an account a bill line can mean: not the
 * AP or AR control account, not a bank account, not an account the VAT return
 * reads, not a header with children, not an inactive one, and not another
 * company's. Pinned through every writer of supplier_invoice_items lines that
 * carry an account: the service the REST route calls, the three MCP tools, and
 * the recurring-bill mint. Each refusal must leave nothing written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import {
  approveSupplierInvoice, postSupplierInvoiceToGL,
} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { mintRecurringSupplierInvoice } from '@/modules/accounting/services/core/recurringTransactionInvoices';
import type { RecurringTemplate } from '@/modules/accounting/services/core/recurringTransactionService';
import { RecurringTemplateLineAccountError } from '@/modules/accounting/services/core/recurringTransactionErrors';
import { createSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkCreateSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkInvoices';
import { updateSupplierInvoiceTool } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let other: Fixture;
let seq = 0;
const acc: Record<string, string> = {};

const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, companyRole: 'owner', tokenJti: 'jti-b' }) as unknown as McpToolContext;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const num = () => `BLA${++seq}-${fx.tag}`.slice(0, 50);

async function accountBySubtype(companyId: string, subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${companyId}::UUID AND account_subtype = ${subtype}
    LIMIT 1`) as Row[])[0]!.id);
}

async function addAccount(code: string, type: string, subtype: string | null, opts: {
  active?: boolean; parent?: string;
} = {}): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, parent_account_id)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, ${type}, ${subtype},
            'debit', ${opts.active ?? true}, ${opts.parent ?? null})
    RETURNING id`) as Row[])[0]!.id);
}

async function billCount(): Promise<number> {
  return Number(((await sql`
    SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);
}

const createViaService = (glAccountId: string) => inTx(fx, () => createSupplierInvoice(fx.companyId, {
  supplierId: fx.supplierId, invoiceNumber: num(), invoiceDate: '2026-05-01',
  items: [{ description: 'Line', quantity: 1, unitPrice: 100, glAccountId }],
}, fx.userId));

const createViaMcp = (glAccountId: string) => inTx(fx, () => createSupplierInvoiceTool.handler({
  supplier_id: fx.supplierId, invoice_number: num(), invoice_date: '2026-05-01',
  lines: [{ description: 'Line', quantity: 1, unit_price: 100, gl_account_id: glAccountId }],
  idempotency_key: `k-${++seq}`,
}, ctx()));

const bulkViaMcp = (glAccountId: string) => inTx(fx, () => bulkCreateSupplierInvoicesTool.handler({
  invoices: [
    { supplier_id: fx.supplierId, invoice_number: num(), invoice_date: '2026-05-01',
      lines: [{ description: 'Fine', quantity: 1, unit_price: 10, gl_account_id: acc.expense }] },
    { supplier_id: fx.supplierId, invoice_number: num(), invoice_date: '2026-05-01',
      lines: [{ description: 'Line', quantity: 1, unit_price: 100, gl_account_id: glAccountId }] },
  ],
  idempotency_key: `k-${++seq}`,
}, ctx()));

const mintRecurring = (glAccountId: string) => inTx(fx, () => mintRecurringSupplierInvoice(fx.companyId, {
  id: `tpl-${++seq}`, companyId: fx.companyId, name: 'Rent', entityType: 'supplier_invoice',
  templateData: { supplierId: fx.supplierId, lines: [{ description: 'Rent', quantity: 1, unitPrice: 100, glAccountId }] },
  frequency: 'monthly', nextRunDate: null, lastRunDate: null, isActive: true, autoPost: false,
  createdBy: fx.userId, createdAt: '2026-05-01',
} as RecurringTemplate, fx.userId));

describeIfDb('supplier-bill line accounts', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates supplier bills and GL accounts.');
    fx = await seedFixture('BLA', DATABASE_URL!);
    other = await seedFixture('BLX', DATABASE_URL!);
    acc.expense = await accountBySubtype(fx.companyId, 'default_expense');
    acc.payable = await accountBySubtype(fx.companyId, 'payable');
    acc.receivable = await accountBySubtype(fx.companyId, 'receivable');
    acc.bank = await accountBySubtype(fx.companyId, 'bank');
    acc.vatInput = await accountBySubtype(fx.companyId, 'vat_input');
    acc.vatOutput = await accountBySubtype(fx.companyId, 'vat_output');
    // Spellings the canonicaliser folds onto the control subtypes.
    acc.creditors = await addAccount('2101', 'liability', 'accounts_payable');
    acc.tax = await addAccount('2130', 'liability', 'tax');
    acc.inactive = await addAccount('6100', 'expense', 'operating_expense', { active: false });
    acc.header = await addAccount('6200', 'expense', 'operating_expense');
    acc.child = await addAccount('6210', 'expense', 'operating_expense', { parent: acc.header });
    acc.foreign = await accountBySubtype(other.companyId, 'default_expense');
    // Sage's imported controls: live, system, and subtyped generically.
    acc.sagePayables = await addAccount('SYS-8', 'liability', 'current_liabilities');
    acc.sageVat = await addAccount('SYS9', 'liability', null);
    acc.sageOpening = await addAccount('SYS13', 'equity', 'equity');
    acc.obe = await addAccount('3900', 'equity', 'opening_balance_equity');
    acc.retained = await addAccount('3200', 'equity', 'retained_earnings');
    acc.accDep = await addAccount('1290', 'asset', 'accumulated_depreciation');
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM approval_requests WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM supplier_coding_history WHERE company_id = ${f.companyId}::UUID`;
      await sql`UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
    }
  }, 120000);

  const refused: [string, string, RegExp][] = [
    ['AP control', 'payable', /control account/i],
    ['AP control under an alias subtype', 'creditors', /control account/i],
    ['AR control', 'receivable', /control account/i],
    ['bank', 'bank', /bank account/i],
    ['VAT input', 'vatInput', /VAT/],
    ['VAT output', 'vatOutput', /VAT/],
    ['a subtype the VAT return reads', 'tax', /VAT/],
    ['Sage SYS-8 Trade Payables', 'sagePayables', /Sage control or system account/],
    ['Sage SYS9 VAT Payable with no subtype', 'sageVat', /Sage control or system account/],
    ['Sage SYS13 Opening Balance and VAT Adjustments', 'sageOpening', /Sage control or system account/],
    ['opening balance equity', 'obe', /opening balances/],
    ['retained earnings', 'retained', /year-end close/],
    ['accumulated depreciation', 'accDep', /depreciation/],
    ['a header account', 'header', /header/i],
    ['an inactive account', 'inactive', /inactive/i],
    ['another company\'s account', 'foreign', /not GL accounts in your company/],
  ];

  describe.each(refused)('refuses %s', (_label, key, message) => {
    it('through the service the REST route calls', async () => {
      const before = await billCount();
      await expect(createViaService(acc[key]!)).rejects.toThrow(message);
      expect(await billCount()).toBe(before);
    });

    it('through create_supplier_invoice', async () => {
      const before = await billCount();
      const r = await createViaMcp(acc[key]!);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(message);
      expect(await billCount()).toBe(before);
    });

    it('through bulk_create_supplier_invoices, before the first element writes', async () => {
      const before = await billCount();
      const r = await bulkViaMcp(acc[key]!);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(message);
      expect(await billCount()).toBe(before);
    });

    it('through update_supplier_invoice, leaving the draft\'s lines as they were', async () => {
      const bill = await createViaService(acc.expense!);
      const r = await inTx(fx, () => updateSupplierInvoiceTool.handler({
        invoice_id: bill.id,
        lines: [{ description: 'Line', quantity: 1, unit_price: 100, gl_account_id: acc[key]! }],
        idempotency_key: `k-${++seq}`,
      }, ctx()));
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(message);
      const lines = (await sql`
        SELECT gl_account_id FROM supplier_invoice_items WHERE supplier_invoice_id = ${bill.id}::UUID`) as Row[];
      expect(lines.map((l) => l.gl_account_id)).toEqual([acc.expense]);
    });

    it('through the recurring-bill mint, as the template error the route answers 400', async () => {
      const before = await billCount();
      const err = await mintRecurring(acc[key]!).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RecurringTemplateLineAccountError);
      expect((err as Error).message).toMatch(message);
      expect(await billCount()).toBe(before);
    });
  });

  it('names the offending element of a bulk create', async () => {
    const r = await bulkViaMcp(acc.bank!);
    expect(text(r)).toMatch(/^invoices\[1\]: A bill line cannot be coded to 1000 Bank/);
  });

  it('names the offending account in the refusal', async () => {
    await expect(createViaService(acc.bank!)).rejects.toThrow(/1000 Bank/);
  });

  it('accepts an ordinary expense account and a leaf under a header on every writer', async () => {
    for (const id of [acc.expense!, acc.child!]) {
      await expect(createViaService(id)).resolves.toMatchObject({ status: 'draft' });
      expect((await createViaMcp(id)).isError).toBeFalsy();
      expect((await bulkViaMcp(id)).isError).toBeFalsy();
      await expect(mintRecurring(id)).resolves.toMatchObject({ posted: false });
    }
  });

  it('reads one id in two cases as one account', async () => {
    const bill = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
      supplierId: fx.supplierId, invoiceNumber: num(), invoiceDate: '2026-05-01',
      items: [
        { description: 'A', quantity: 1, unitPrice: 1, glAccountId: acc.expense!.toUpperCase() },
        { description: 'B', quantity: 1, unitPrice: 1, glAccountId: acc.expense! },
      ],
    }, fx.userId));
    expect(bill.status).toBe('draft');
  });

  describe('re-checks the stored lines when the bill posts', () => {
    // The account was fine when the line named it and is reclassified after.
    async function billOnAccountLaterMadeBank(): Promise<{ billId: string; account: string }> {
      const account = await addAccount(`64${++seq}`, 'expense', 'operating_expense');
      const bill = await createViaService(account);
      await sql`UPDATE gl_accounts SET account_subtype = 'bank' WHERE id = ${account}::UUID`;
      return { billId: bill.id, account };
    }
    const journalOf = async (id: string) => ((await sql`
      SELECT gl_journal_entry_id, status FROM supplier_invoices WHERE id = ${id}::UUID`) as Row[])[0]!;

    it('on approve', async () => {
      const { billId } = await billOnAccountLaterMadeBank();
      await expect(inTx(fx, () => approveSupplierInvoice(fx.companyId, billId, fx.userId)))
        .rejects.toThrow(/bank account.*Recode the line on the draft, or cancel/);
      expect(await journalOf(billId)).toEqual({ gl_journal_entry_id: null, status: 'draft' });
    });

    it('on Post to GL', async () => {
      const { billId } = await billOnAccountLaterMadeBank();
      await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${billId}::UUID`;
      await expect(inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, billId, fx.userId)))
        .rejects.toThrow(/bank account/);
      expect((await journalOf(billId)).gl_journal_entry_id).toBeNull();
    });

    it('on bulk approve, as a skip the dry run predicts, posting the rest', async () => {
      const { billId: bad } = await billOnAccountLaterMadeBank();
      const good = (await createViaService(acc.expense!)).id;
      const call = (dry: boolean) => inTx(fx, () => bulkApproveSupplierInvoicesTool.handler({
        invoice_ids: [bad, good], dry_run: dry, idempotency_key: `k-${++seq}`,
      }, ctx()));
      const preview = JSON.parse(text(await call(true)));
      expect(preview.would_post_ids).toEqual([good]);
      expect(preview.skipped).toEqual([expect.objectContaining({ document_id: bad, reason: expect.stringMatching(/bank account/) })]);
      const live = await call(false);
      expect(live.isError).toBeFalsy();
      expect(JSON.parse(text(live)).skipped.map((x: Row) => x.document_id)).toEqual([bad]);
      expect((await journalOf(good)).status).toBe('approved');
      expect(await journalOf(bad)).toEqual({ gl_journal_entry_id: null, status: 'draft' });
    });

    it('on bulk approve, skipping a stored line on another company\'s account with the wording approve gives', async () => {
      const bill = await createViaService(acc.expense!);
      await sql`UPDATE supplier_invoice_items SET gl_account_id = ${acc.foreign!}::UUID
                WHERE supplier_invoice_id = ${bill.id}::UUID`;
      const approveErr = await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId))
        .catch((e: unknown) => (e as Error).message);
      const r = await inTx(fx, () => bulkApproveSupplierInvoicesTool.handler({
        invoice_ids: [bill.id], dry_run: true, idempotency_key: `k-${++seq}`,
      }, ctx()));
      const skipped = JSON.parse(text(r)).skipped;
      expect(skipped.map((x: Row) => x.reason)).toEqual([approveErr]);
      expect(approveErr).toMatch(/not GL accounts in your company/);
    });

    it('on bulk approve, NOT skipping a draft that already carries a journal — approve reuses it, as single approve does', async () => {
      const { billId } = await billOnAccountLaterMadeBank();
      await sql`UPDATE gl_accounts SET account_subtype = 'operating_expense'
                WHERE id = (SELECT gl_account_id FROM supplier_invoice_items WHERE supplier_invoice_id = ${billId}::UUID)`;
      await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${billId}::UUID`;
      await inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, billId, fx.userId));
      await sql`UPDATE supplier_invoices SET status = 'draft' WHERE id = ${billId}::UUID`;
      await sql`UPDATE gl_accounts SET account_subtype = 'bank'
                WHERE id = (SELECT gl_account_id FROM supplier_invoice_items WHERE supplier_invoice_id = ${billId}::UUID)`;
      const r = await inTx(fx, () => bulkApproveSupplierInvoicesTool.handler({
        invoice_ids: [billId], idempotency_key: `k-${++seq}`,
      }, ctx()));
      expect(r.isError).toBeFalsy();
      expect((await journalOf(billId)).status).toBe('approved');
    });

    it('and still approves a bill whose accounts are fine', async () => {
      const bill = await createViaService(acc.expense!);
      await expect(inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId)))
        .resolves.toMatchObject({ status: 'approved' });
    });
  });

  it('still accepts a line with no account at all', async () => {
    const bill = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
      supplierId: fx.supplierId, invoiceNumber: num(), invoiceDate: '2026-05-01',
      items: [{ description: 'Uncoded', quantity: 1, unitPrice: 5 }],
    }, fx.userId));
    expect(bill.status).toBe('draft');
  });
});
