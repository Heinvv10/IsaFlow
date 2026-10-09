/**
 * A new customer invoice keeps each line's discount through to the ledger.
 * Creation used to store the undiscounted amount, so a 10% discount on a
 * R1,000 line was saved, approved and posted as R1,000 + VAT: the client was
 * billed more than the new-invoice page showed. Now the line, the header and
 * the journal all carry R900.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice, type DraftInvoiceLineInput } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

// The sealed PDF is evidence storage, not posting; approve already treats its failure as non-blocking.
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function createAndApprove(items: DraftInvoiceLineInput[]): Promise<{ id: string; je: string }> {
  const { id } = await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 15, items,
  }));
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
});
