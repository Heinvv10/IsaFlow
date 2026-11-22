/**
 * Migration 1018 does not break the writers it leaves alone: the approve and cancel services of a customer invoice, a
 * supplier bill and a credit note, run as app_user inside a request transaction (RLS, the member's claims), still post,
 * link, reverse, unlink and cancel. The wider paths (payroll, VAT, bank, recurring, MCP) run in their own suites on
 * the same schema, which carries the migration.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice, cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropFreeze, seedFreeze, type Freeze, type Row } from './helpers/ledgerFreezeFixture';
import { inAppUserTx } from './helpers/appUserTx';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const contraOf = async (je: string) => one(sql`SELECT id, status FROM gl_journal_entries WHERE reversal_of_id = ${je}::UUID`);

describeIfDisposable('ledger column immutability: the approve and cancel services still work as app_user (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it('a customer invoice: approve posts and links, cancel reverses, unlinks and cancels', async () => {
    const { fx } = z.f;
    const id = (await inAppUserTx(fx, () => createDraftCustomerInvoice(fx.companyId, fx.userId, {
      clientId: fx.customerId, invoiceDate: '2026-06-10', taxRate: 15, items: [{ description: 'Work', unitPrice: 200 }] }))).id;
    await inAppUserTx(fx, () => approveCustomerInvoice(fx.companyId, id, fx.userId));
    const approved = await one(sql`SELECT status, gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`);
    expect(approved.status).toBe('approved');
    expect(approved.je).not.toBeNull();
    await inAppUserTx(fx, () => cancelCustomerInvoice(fx.companyId, id, fx.userId, { allowReversal: true }));
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).toMatchObject({ status: 'cancelled', je: null });
    expect((await contraOf(String(approved.je))).status).toBe('posted');
  });

  it('a supplier bill: approve posts and links, cancel reverses, unlinks and cancels', async () => {
    const { fx } = z.f;
    const bill = await inAppUserTx(fx, () => createSupplierInvoice(fx.companyId, { supplierId: fx.supplierId, invoiceNumber: 'LCI-B1',
      invoiceDate: '2026-06-10', items: [{ description: 'Line', quantity: 1, unitPrice: 300, glAccountId: z.expense }] }, fx.userId));
    await inAppUserTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId));
    const approved = await one(sql`SELECT status, gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`);
    expect(approved).toMatchObject({ status: 'approved' });
    expect(approved.je).not.toBeNull();
    await inAppUserTx(fx, () => cancelSupplierInvoice(fx.companyId, bill.id, fx.userId));
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).toMatchObject({ status: 'cancelled', je: null });
    expect((await contraOf(String(approved.je))).status).toBe('posted');
  });

  it('a credit note: approve posts and links, cancel reverses its journal and keeps the link', async () => {
    const { fx } = z.f;
    const cn = await inAppUserTx(fx, () => createCreditNote(fx.companyId, { type: 'customer', clientId: fx.customerId,
      creditDate: '2026-06-20', subtotal: 50, taxRate: 0 }, fx.userId));
    const je = String((await inAppUserTx(fx, () => approveCreditNote(fx.companyId, cn.id, fx.userId))).glJournalEntryId);
    expect(je).not.toBe('null');
    await inAppUserTx(fx, () => cancelCreditNote(fx.companyId, cn.id, fx.userId));
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM credit_notes WHERE id = ${cn.id}::UUID`)).toMatchObject({ status: 'cancelled', je });
    expect((await contraOf(je)).status).toBe('posted');
  });
});
