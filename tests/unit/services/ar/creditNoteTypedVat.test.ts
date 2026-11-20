/**
 * The VAT a customer credit note LINKED to a TYPED invoice is created with (creditNoteTypedVat), so a note made through
 * REST or MCP with no VAT given is approvable: requiredCreditNoteVat on the invoice's remaining net and VAT, never the
 * rate on its subtotal. A caller's taxRate is accepted only when it gives that figure; an explicit taxAmount, an
 * unlinked note, a supplier note and a note against a legacy invoice are left to the existing rule. `sql` is answered by
 * statement text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: null as { remainingNet: number; remainingVat: number } | null,
  rate: '15.00' as string | null,
}));
vi.mock('@/modules/accounting/services/ar/invoiceRevenuePosting', () => ({ typedInvoiceCreditState: vi.fn(async () => h.state) }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('FROM customer_invoices')
    ? (h.rate === null ? [] : [{ tax_rate: h.rate, invoice_number: 'INV-9' }]) : [])),
}));

import { typedCreditNoteVat } from '@/modules/accounting/services/ar/creditNoteTypedVat';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';

const CO = '11111111-1111-4111-8111-111111111111';
const INV = '22222222-2222-4222-8222-222222222222';
const note = (over: Record<string, unknown> = {}) => ({ type: 'customer' as const, customerInvoiceId: INV, subtotal: 150, ...over });

beforeEach(() => { h.state = { remainingNet: 1500, remainingVat: 150 }; h.rate = '15.00'; vi.mocked(typedInvoiceCreditState).mockClear(); });

describe('a note linked to a typed invoice, no VAT given', () => {
  it('150 of the 1000 / 300 / 200 invoice carries 15.00 (not 22.50 at 15% on its subtotal), at the invoice\'s rate', async () => {
    expect(await typedCreditNoteVat(CO, note())).toEqual({ taxAmount: 15, taxRate: 15 });
  });
  it('the whole remaining net carries exactly the remaining VAT', async () => {
    h.state = { remainingNet: 1349.99, remainingVat: 134.99 };
    expect(await typedCreditNoteVat(CO, note({ subtotal: 1349.99 }))).toEqual({ taxAmount: 134.99, taxRate: 15 });
  });
  it('an exempt-only invoice (rate 0): VAT 0 at 0%', async () => {
    h.state = { remainingNet: 1000, remainingVat: 0 }; h.rate = '0.00';
    expect(await typedCreditNoteVat(CO, note({ subtotal: 400 }))).toEqual({ taxAmount: 0, taxRate: 0 });
  });
});

describe('a caller\'s taxRate on such a note', () => {
  it('is accepted when it gives the required figure', async () => {
    h.state = { remainingNet: 1000, remainingVat: 150 };
    expect(await typedCreditNoteVat(CO, note({ subtotal: 100, taxRate: 15 }))).toEqual({ taxAmount: 15, taxRate: 15 });
  });
  it('is refused otherwise, naming the required VAT, before any write', async () => {
    const err = await typedCreditNoteVat(CO, note({ taxRate: 15 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditNoteVatSplitRefusal);
    expect((err as CreditNoteVatSplitRefusal).code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
    expect((err as Error).message).toBe('A credit note crediting 150.00 of invoice INV-9 (1500.00 left to credit) must carry VAT of 15.00, '
      + 'its remaining VAT in proportion; taxRate 15 gives 22.50. Leave taxRate out (the VAT then defaults to 15.00) or send taxAmount 15.00. '
      + 'An invoice with a VAT type per line is credited in proportion across its lines.');
  });
});

describe('what approve would refuse anyway is refused at create', () => {
  it('more than the invoice has left', async () => {
    await expect(typedCreditNoteVat(CO, note({ subtotal: 1600 }))).rejects.toThrow(/credits 1600\.00, but invoice INV-9 has 1500\.00 left to credit/);
  });
  it('an invoice with nothing left, or VAT already over-reversed', async () => {
    h.state = { remainingNet: 0, remainingVat: 0 };
    await expect(typedCreditNoteVat(CO, note())).rejects.toBeInstanceOf(CreditNoteVatSplitRefusal);
    h.state = { remainingNet: 1000, remainingVat: -1 };
    await expect(typedCreditNoteVat(CO, note())).rejects.toThrow(/VAT is already fully reversed/);
  });
});

describe('left to the existing rule (null)', () => {
  it.each([
    ['an explicit taxAmount (approve is the gate)', note({ taxAmount: 22.5 })],
    ['an unlinked note', note({ customerInvoiceId: undefined })],
    ['a supplier note', note({ type: 'supplier' })],
  ])('%s, without reading the invoice', async (_l, n) => {
    expect(await typedCreditNoteVat(CO, n as Parameters<typeof typedCreditNoteVat>[1])).toBeNull();
    expect(typedInvoiceCreditState).not.toHaveBeenCalled();
  });
  it('a note against a legacy invoice (or one not posted)', async () => {
    h.state = null;
    expect(await typedCreditNoteVat(CO, note({ taxRate: 15 }))).toBeNull();
  });
});
