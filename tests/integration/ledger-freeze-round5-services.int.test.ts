/**
 * Migration 1018, review round 5 (N2), through the real services as the PRODUCTION login (helpers/appLoginWorld): the
 * soft delete (reverse the head, then deleted_at) and its undo (clear deleted_at, then re-reverse) still work for an
 * invoice and a bill, and while the document is deleted a hand re-reversal of its chain is refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld, FIXTURE_LOGIN } from './helpers/appLoginWorld';
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
const headOf = async (o: string) => String((await one(sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${o}::UUID`)).id);

describeIfDisposable('ledger column immutability, round 5: soft delete and undo as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => { if (world) await world.close(); if (z) await dropFreeze(z); }, 120000);

  async function roundTrip(entityType: 'customer_invoice' | 'supplier_invoice', id: string, o: string) {
    const { softDelete, undoDelete } = await world.load(() => import('@/modules/accounting/services/core/softDeleteService'));
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const { fx } = z.f;
    await world.run(who, () => softDelete(fx.companyId, entityType, id, fx.userId));
    expect(await inForce(o)).toBe(false);
    const head = await headOf(o);
    const err = await world.run(who, () => reverseJournalEntry(fx.companyId, head, fx.userId))
      .then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err?.code).toBe('JOURNAL_REINSTATES_CANCELLED_DOCUMENT'); // deleted, not restored: the chain stays out
    expect(await world.run(who, () => undoDelete(fx.companyId, entityType, id, fx.userId))).toBe(true);
    expect(await inForce(o)).toBe(true);
  }

  it('the transaction is the production-shaped login -> app_user and not a superuser', async () => {
    expect(await world.probe(who)).toEqual({ sessionUser: FIXTURE_LOGIN, currentUser: 'app_user', superuser: 'off' });
  });

  it('N2 a customer invoice: soft delete, a refused hand re-reversal, undo', async () => {
    const { createDraftCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCreateService'));
    const { approveCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceApprovalService'));
    const { fx } = z.f;
    const id = (await world.run(who, () => createDraftCustomerInvoice(fx.companyId, fx.userId, {
      clientId: fx.customerId, invoiceDate: '2026-06-11', taxRate: 15, items: [{ description: 'Work', unitPrice: 140 }] }))).id;
    await world.run(who, () => approveCustomerInvoice(fx.companyId, id, fx.userId));
    const o = String((await one(sql`SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).je);
    await roundTrip('customer_invoice', id, o);
  });

  it('N2 a supplier bill: soft delete, a refused hand re-reversal, undo', async () => {
    const { createSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceService'));
    const { approveSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const { fx } = z.f;
    const bill = await world.run(who, () => createSupplierInvoice(fx.companyId, { supplierId: fx.supplierId, invoiceNumber: 'R5-B1',
      invoiceDate: '2026-06-10', items: [{ description: 'Line', quantity: 1, unitPrice: 260, glAccountId: z.expense }] }, fx.userId));
    await world.run(who, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId));
    const o = String((await one(sql`SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).je);
    await roundTrip('supplier_invoice', bill.id, o);
  });
});
