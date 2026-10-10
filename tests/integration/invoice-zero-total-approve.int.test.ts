/**
 * An invoice totalling R0.00 has no journal to post: its AR control line would
 * be 0/0, which the journal validator refuses. Approving one used to get that far,
 * after the status UPDATE, and answer a 500 ("A line must have a non-zero debit
 * or credit amount"). A draft whose every line is 100% discounted reaches it
 * from the new-invoice page. Approve now refuses it before the status moves,
 * with InvoiceNotApprovableError (a 400 at the route, a tool error over MCP),
 * as bulk finalize already skips it.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice, type DraftInvoiceLineInput } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import {
  approveCustomerInvoice, InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

const draft = async (items: DraftInvoiceLineInput[]) => (await inTx(f.fx, () => createDraftCustomerInvoice(
  f.fx.companyId, f.fx.userId, { clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 15, items }))).id;
const state = async (id: string) => ((await sql`
  SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${f.fx.companyId}::UUID`) as
  { status: string; gl_journal_entry_id: string | null }[])[0]!;
const journals = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);

describeIfDisposable('approving a customer invoice that totals R0.00', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it.each([
    ['every line discounted 100%', [{ description: 'Waived', unitPrice: 500, quantity: 1, discount: 100 }]],
    ['a zero-price line', [{ description: 'Free', unitPrice: 0, quantity: 1 }]],
  ])('%s: refused as not approvable, before the status moves, and posts nothing', async (_label, items) => {
    const id = await draft(items);
    const before = await journals();

    const err = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvoiceNotApprovableError);
    expect((err as InvoiceNotApprovableError).notFound).toBe(false);
    expect((err as Error).message).toMatch(/totals 0\.00/);
    expect(await state(id)).toEqual({ status: 'draft', gl_journal_entry_id: null });
    expect(await journals()).toBe(before);
  });

  it('Post to GL refuses an already-approved 0.00 invoice with no journal, by name, and posts nothing', async () => {
    // Approved before this change (or by hand): the state the Post to GL route can still be handed.
    const id = await draft([{ description: 'Waived', unitPrice: 500, quantity: 1, discount: 100 }]);
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID AND company_id = ${f.fx.companyId}::UUID`;
    const before = await journals();

    const err = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);

    expect((err as Error).message).toBe('This invoice totals 0.00, so there is nothing to post.');
    expect(await state(id)).toEqual({ status: 'approved', gl_journal_entry_id: null });
    expect(await journals()).toBe(before);
  });

  it('an invoice with any charge still approves and posts', async () => {
    const id = await draft([
      { description: 'Waived', unitPrice: 500, quantity: 1, discount: 100 },
      { description: 'Charged', unitPrice: 100, quantity: 1 },
    ]);
    const r = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
    expect(r.glJournalEntryId).toBeTruthy();
    expect((await state(id)).status).toBe('approved');
  });
});
