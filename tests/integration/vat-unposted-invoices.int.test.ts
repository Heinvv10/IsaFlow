/**
 * Unposted invoice VAT blocks eFiling (Hein, 2026-09-25). With the recon on
 * the FILED ledger, an issued invoice or approved bill whose VAT never reached
 * the GL is in neither side, so the recon ties at R0 and the return would file
 * without it. It is a counted exception; posting the documents clears it.
 * Drafts, pending approval, cancelled, disputed and soft-deleted documents do
 * not count — the VAT201 readers' own population.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
const acct: Record<string, string> = {};
let invoice = '';
let bill = '';
const PERIOD = { start: '2026-05-01', end: '2026-06-30' };
const report = () => inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));

async function withVat(table: 'customer_invoices' | 'supplier_invoices', id: string): Promise<void> {
  if (table === 'customer_invoices') {
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150, total_amount = 1150 WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
  } else {
    await sql`UPDATE supplier_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150, total_amount = 1150 WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
  }
}

async function post(source: GLEntrySource, lines: JournalLineInput[]): Promise<string> {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, { entryDate: '2026-05-10', description: source, source, lines }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

describeIfDb('pre-filing exceptions: unposted invoice VAT', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds invoices and posts journals.');
    fx = await seedFixture('VUP', DATABASE_URL!);
    for (const sub of ['receivable', 'payable', 'default_expense', 'vat_input', 'vat_output']) {
      acct[sub] = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${sub} LIMIT 1`) as Row[])[0]!.id);
    }
    acct.sales = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'sales', 'credit', true) RETURNING id`) as Row[])[0]!.id);
    invoice = await seedInvoice(fx, { number: 'INV', date: '2026-05-05', total: 1150, status: 'sent' });
    bill = await seedBill(fx, { number: 'BILL', date: '2026-05-06', total: 1150, status: 'approved' });
    await withVat('customer_invoices', invoice);
    await withVat('supplier_invoices', bill);
    // Not in the VAT201 population: none of these may count.
    for (const status of ['draft', 'pending_approval', 'cancelled']) {
      await withVat('customer_invoices', await seedInvoice(fx, { number: `CI-${status}`, date: '2026-05-07', total: 1150, status }));
    }
    for (const status of ['draft', 'pending_approval', 'disputed', 'cancelled']) {
      await withVat('supplier_invoices', await seedBill(fx, { number: `SI-${status}`, date: '2026-05-07', total: 1150, status }));
    }
    const deleted = await seedInvoice(fx, { number: 'CI-deleted', date: '2026-05-07', total: 1150, status: 'sent' });
    await withVat('customer_invoices', deleted);
    await sql`UPDATE customer_invoices SET deleted_at = NOW() WHERE id = ${deleted}::UUID AND company_id = ${fx.companyId}::UUID`;
  }, 180000);

  afterAll(async () => { if (fx) await dropFixture(fx); }, 120000);

  it('an issued invoice and an approved bill with VAT and no journal block; the recon alone would tie at R0', async () => {
    const r = await report();
    expect(r.controlRecon.outputVariance).toBe(0);
    expect(r.controlRecon.inputVariance).toBe(0);
    expect(r.unpostedInvoiceVat.map((u) => [u.invoiceId, u.invoiceKind, u.vat])).toEqual([
      [invoice, 'customer', 150], [bill, 'supplier', 150],
    ]);
    expect(r.unpostedInvoiceVatCount).toBe(2);
    expect(r.controlRecon).toMatchObject({ unpostedCustomerCount: 1, unpostedCustomerVat: 150, unpostedSupplierCount: 1, unpostedSupplierVat: 150 });
    expect(r.totalExceptions).toBe(2);
    expect(evaluateEfilingGate(r).allowed).toBe(false);
  });

  it('once both are posted the exception clears and the gate lets the period through', async () => {
    const ciJe = await post('auto_invoice', [
      { glAccountId: acct.receivable!, debit: 1150, credit: 0, description: 'AR' },
      { glAccountId: acct.sales!, debit: 0, credit: 1000, description: 'sale', vatType: 'standard' },
      { glAccountId: acct.vat_output!, debit: 0, credit: 150, description: 'VAT', vatType: 'standard' },
    ]);
    const siJe = await post('auto_supplier_invoice', [
      { glAccountId: acct.default_expense!, debit: 1000, credit: 0, description: 'cost' },
      { glAccountId: acct.vat_input!, debit: 150, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: acct.payable!, debit: 0, credit: 1150, description: 'AP' },
    ]);
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${ciJe}::UUID WHERE id = ${invoice}::UUID AND company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${siJe}::UUID WHERE id = ${bill}::UUID AND company_id = ${fx.companyId}::UUID`;
    const r = await report();
    expect(r.unpostedInvoiceVat).toEqual([]);
    expect(r.controlRecon.outputVat201).toBe(150);
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });
  });
});
