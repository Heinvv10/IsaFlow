/**
 * Migration 1018, review round 3 (M1), through the real services as the PRODUCTION login (helpers/appLoginWorld):
 * approve -> cancel -> reverseJournalEntry on the cancel's contra is refused with the service's own message, for an
 * invoice (cancel clears the link), a bill (likewise) and a credit note (cancel keeps it), and nothing it wrote survives.
 * The soft-delete -> undo of an approved invoice, which re-instates the journal of a RESTORED document, still works.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, seedFreeze, type Freeze, type Row } from './helpers/ledgerFreezeFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const inForce = async (je: string) => (await one(sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`)).f;
const contraOf = async (je: string) => String((await one(sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${je}::UUID`)).id);
const MESSAGE = /cannot be reversed: that would put the journal of a cancelled document back in the ledger/;

/** Reverse the cancel's contra R through the service: refused with the typed refusal; R gains no contra; O stays out. */
async function reReverseIsRefused(o: string): Promise<void> {
  const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
  const { fx } = z.f;
  const r = await contraOf(o);
  const err = await world.run(who, () => reverseJournalEntry(fx.companyId, r, fx.userId)).then(() => null, (e: unknown) => e as Error & { code?: string });
  expect(err?.message).toMatch(MESSAGE);
  expect(err?.code).toBe('JOURNAL_REINSTATES_CANCELLED_DOCUMENT');
  expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${r}::UUID`)).n).toBe(0);
  expect((await one(sql`SELECT reversed_at FROM gl_journal_entries WHERE id = ${r}::UUID`)).reversed_at).toBeNull();
  expect(await inForce(o)).toBe(false);
}

describeIfDisposable('ledger column immutability, round 3: the real services as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => { if (world) await world.close(); if (z) await dropFreeze(z); }, 120000);

  it('the transaction is the production-shaped login -> app_user and not a superuser', async () => {
    expect(await world.probe(who)).toEqual({ sessionUser: world.login, currentUser: 'app_user', superuser: 'off' });
  });

  it('M1 a customer invoice approved and cancelled: re-reversing the cancel is refused', async () => {
    const { createDraftCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCreateService'));
    const { approveCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceApprovalService'));
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    const { fx } = z.f;
    const id = (await world.run(who, () => createDraftCustomerInvoice(fx.companyId, fx.userId, {
      clientId: fx.customerId, invoiceDate: '2026-06-10', taxRate: 15, items: [{ description: 'Work', unitPrice: 200 }] }))).id;
    await world.run(who, () => approveCustomerInvoice(fx.companyId, id, fx.userId));
    const o = String((await one(sql`SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).je);
    await world.run(who, () => cancelCustomerInvoice(fx.companyId, id, fx.userId));
    await reReverseIsRefused(o);
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).toMatchObject({ status: 'cancelled', je: null });
  });

  it('M1 a supplier bill approved and cancelled: re-reversing the cancel is refused', async () => {
    const { createSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceService'));
    const { approveSupplierInvoice, cancelSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const { fx } = z.f;
    const bill = await world.run(who, () => createSupplierInvoice(fx.companyId, { supplierId: fx.supplierId, invoiceNumber: 'R3-B1',
      invoiceDate: '2026-06-10', items: [{ description: 'Line', quantity: 1, unitPrice: 300, glAccountId: z.expense }] }, fx.userId));
    await world.run(who, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId));
    const o = String((await one(sql`SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).je);
    await world.run(who, () => cancelSupplierInvoice(fx.companyId, bill.id, fx.userId));
    await reReverseIsRefused(o);
  });

  it('M1 a credit note approved and cancelled (it keeps its link): re-reversing the cancel is refused', async () => {
    const { createCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteService'));
    const { approveCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteApproveService'));
    const { cancelCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteCancelService'));
    const { fx } = z.f;
    const cn = await world.run(who, () => createCreditNote(fx.companyId, { type: 'customer', clientId: fx.customerId, creditDate: '2026-06-20', subtotal: 50, taxRate: 0 }, fx.userId));
    const o = String((await world.run(who, () => approveCreditNote(fx.companyId, cn.id, fx.userId))).glJournalEntryId);
    await world.run(who, () => cancelCreditNote(fx.companyId, cn.id, fx.userId));
    await reReverseIsRefused(o);
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM credit_notes WHERE id = ${cn.id}::UUID`)).toMatchObject({ status: 'cancelled', je: o });
  });

  it('a soft-deleted approved invoice restores: the undo re-instates the journal of a document that is not cancelled', async () => {
    const { createDraftCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCreateService'));
    const { approveCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceApprovalService'));
    const { softDelete, undoDelete } = await world.load(() => import('@/modules/accounting/services/core/softDeleteService'));
    const { fx } = z.f;
    const id = (await world.run(who, () => createDraftCustomerInvoice(fx.companyId, fx.userId, {
      clientId: fx.customerId, invoiceDate: '2026-06-11', taxRate: 15, items: [{ description: 'Work', unitPrice: 120 }] }))).id;
    await world.run(who, () => approveCustomerInvoice(fx.companyId, id, fx.userId));
    const o = String((await one(sql`SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).je);
    await world.run(who, () => softDelete(fx.companyId, 'customer_invoice', id, fx.userId));
    expect(await inForce(o)).toBe(false);
    expect(await world.run(who, () => undoDelete(fx.companyId, 'customer_invoice', id, fx.userId))).toBe(true);
    expect(await inForce(o)).toBe(true);
  });
});
