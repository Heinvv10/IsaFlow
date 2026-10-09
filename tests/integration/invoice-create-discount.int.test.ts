/**
 * A new customer invoice keeps each line's discount through to the ledger.
 * Creation used to store the undiscounted amount, so a 10% discount on a
 * R1,000 line was saved, approved and posted as R1,000 + VAT: the client was
 * billed more than the new-invoice page showed. Now the line, the header and
 * the journal all carry R900 — and saving that draft unchanged through the
 * draft edit (as the edit page reads it back) moves nothing.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice, type DraftInvoiceLineInput } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { editDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceDraftEdit';
import { discountFromAmount } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

// The sealed PDF is evidence storage, not posting; approve already treats its failure as non-blocking.
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

const create = async (items: DraftInvoiceLineInput[]): Promise<string> => (await inTx(f.fx, () =>
  createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 15, items }))).id;

async function createAndApprove(items: DraftInvoiceLineInput[]): Promise<{ id: string; je: string }> {
  const id = await create(items);
  const r = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return { id, je: r.glJournalEntryId! };
}

const stored = async (id: string) => {
  const [h] = (await sql`
    SELECT subtotal::float, tax_amount::float AS tax, total_amount::float AS total, functional_total::float AS functional
      FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${f.fx.companyId}::UUID`) as Record<string, number>[];
  const lines = (await sql`
    SELECT cii.amount::float AS amount FROM customer_invoice_items cii
      JOIN customer_invoices ci ON ci.id = cii.invoice_id
     WHERE cii.invoice_id = ${id}::UUID AND ci.company_id = ${f.fx.companyId}::UUID
     ORDER BY cii.amount DESC`) as { amount: number }[];
  return { ...h, lines: lines.map((l) => l.amount) };
};

const legs = async (je: string) => (await sql`
  SELECT a.account_code AS code, jl.debit::float AS debit, jl.credit::float AS credit
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
   WHERE jl.journal_entry_id = ${je}::UUID AND jl.company_id = ${f.fx.companyId}::UUID
   ORDER BY a.account_code`) as { code: string; debit: number; credit: number }[];

const revenueTags = async (je: string) => (await sql`
  SELECT a.account_code AS code, jl.credit::float AS credit, jl.cc1_id AS cc1, jl.cc2_id AS cc2
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
   WHERE jl.journal_entry_id = ${je}::UUID AND jl.company_id = ${f.fx.companyId}::UUID AND a.account_type = 'revenue'
   ORDER BY a.account_code`) as { code: string; credit: number; cc1: string | null; cc2: string | null }[];

/** The stored lines as the edit page loads them: quantity, price, and the discount read back from the amount. */
const asEditPageSends = async (id: string) => ((await sql`
  SELECT cii.description, cii.quantity::float AS quantity, cii.unit_price::float AS unit_price, cii.amount::float AS amount
    FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
   WHERE cii.invoice_id = ${id}::UUID AND ci.company_id = ${f.fx.companyId}::UUID
   ORDER BY cii.description`) as { description: string; quantity: number; unit_price: number; amount: number }[])
  .map((r) => ({ description: r.description, quantity: r.quantity, unitPrice: r.unit_price,
    discount: discountFromAmount(r.quantity, r.unit_price, r.amount) }));

describeIfDisposable('creating a customer invoice with a line discount', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a 10% discount on a R1,000 line is stored, approved and posted as R900: revenue 900, VAT 135, AR 1,035', async () => {
    const { id, je } = await createAndApprove([{ description: 'Consulting', unitPrice: 1000, quantity: 1, discount: 10 }]);

    expect(await stored(id)).toEqual({ subtotal: 900, tax: 135, total: 1035, functional: 1035, lines: [900] });
    expect(await legs(je)).toEqual([
      { code: '1100', debit: 1035, credit: 0 },
      { code: '2120', debit: 0, credit: 135 },
      { code: '4000', debit: 0, credit: 900 },
    ]);
  });

  it('a discounted CODED line posts its discounted amount to its own revenue account', async () => {
    const { id, je } = await createAndApprove([
      { description: 'TV spot', unitPrice: 1000, quantity: 1, discount: 10, glAccountId: f.acct.commercials },
      { description: 'Admin fee', unitPrice: 500, quantity: 1 },
    ]);

    expect(await stored(id)).toEqual({ subtotal: 1400, tax: 210, total: 1610, functional: 1610, lines: [900, 500] });
    expect(await legs(je)).toEqual([
      { code: '1100', debit: 1610, credit: 0 },
      { code: '2120', debit: 0, credit: 210 },
      { code: '4000', debit: 0, credit: 500 },
      { code: '4100', debit: 0, credit: 900 },
    ]);
  });

  it('a discounted line tagged with a CC2 posts its discounted amount on that CC2, its CC1 derived', async () => {
    const { je } = await createAndApprove([
      { description: 'Grade', unitPrice: 4000, quantity: 1, discount: 25, glAccountId: f.acct.postProduction, cc2Id: f.dim.cc2 },
    ]);
    expect(await revenueTags(je)).toEqual([{ code: '4200', credit: 3000, cc1: f.dim.fno, cc2: f.dim.cc2 }]);
  });

  it('saving the created draft unchanged through the draft edit moves nothing — not a cent', async () => {
    const id = await create([
      // Five lines of 87.49125, stored 87.49: Σ stored 437.45, round(Σ unrounded) 437.46.
      ...['A1', 'A2', 'A3', 'A4', 'A5'].map((description) => ({ description, unitPrice: 33.33, quantity: 3, discount: 12.5 })),
      { description: 'B', unitPrice: 1000, quantity: 1, discount: 12.34 },   // 876.60
      { description: 'D', unitPrice: 0.125, quantity: 1 },                   // stored 0.13
      { description: 'E', unitPrice: 0.1, quantity: 1 },
    ]);
    const before = await stored(id);
    expect(before.subtotal).toBe(before.lines.reduce((s, a) => Math.round((s + a) * 100) / 100, 0));

    const r = await inTx(f.fx, async () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, items: await asEditPageSends(id) }));
    expect(r).toEqual({ kind: 'ok' });
    expect(await stored(id)).toEqual(before);
  });

  it('a two-place discount on a R10m line reads back exactly, so an unchanged save moves nothing', async () => {
    const id = await create([{ description: 'Big', unitPrice: 9999.99, quantity: 1000, discount: 87.26 }]);
    const before = await stored(id);
    const r = await inTx(f.fx, async () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, items: await asEditPageSends(id) }));
    expect(r).toEqual({ kind: 'ok' });
    expect(await stored(id)).toEqual(before);
  });

  it('the draft edit refuses a total its column cannot hold (a 400, not numeric overflow), and writes nothing', async () => {
    const id = await create([{ description: 'Small', unitPrice: 10, quantity: 1 }]);
    const before = await stored(id);
    const r = await inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
      id, items: [{ description: 'Huge', unitPrice: 9e12, quantity: 1 }],
    }));
    expect(r).toEqual({ kind: 'bad_amount', message: 'The invoice total is too large' });
    expect(await stored(id)).toEqual(before);
  });

  it('a new exchange rate alone that would overflow functional_total is refused too, and writes nothing', async () => {
    await sql`UPDATE companies SET fx_documents_enabled = true WHERE id = ${f.fx.companyId}::UUID`;
    try {
      const { id } = await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
        clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 0, currencyCode: 'USD', exchangeRate: 1,
        items: [{ description: 'Large', unitPrice: 8e12, quantity: 1 }],
      }));
      const before = await stored(id);
      const r = await inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, notes: 'changed', exchangeRate: 1000 }));
      expect(r).toEqual({ kind: 'bad_amount', message: 'The invoice total is too large' });
      expect(await stored(id)).toEqual(before);
      const [n] = (await sql`SELECT notes FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${f.fx.companyId}::UUID`) as { notes: string | null }[];
      expect(n!.notes).toBeNull();

      // An edit that does not rewrite functional_total is not checked against it: a stored rate that drifted
      // from it (only reachable by hand) must not lock the notes.
      await sql`UPDATE customer_invoices SET exchange_rate = 1000 WHERE id = ${id}::UUID AND company_id = ${f.fx.companyId}::UUID`;
      expect(await inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, notes: 'notes only' })))
        .toEqual({ kind: 'ok' });
    } finally {
      await sql`UPDATE companies SET fx_documents_enabled = false WHERE id = ${f.fx.companyId}::UUID`;
    }
  });
});
