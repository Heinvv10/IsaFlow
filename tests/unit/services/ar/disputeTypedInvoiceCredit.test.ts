/**
 * A dispute resolved with credit against a TYPED invoice (every revenue leg VAT-coded): the note it raises is
 * proportional only (Hein, 2026-11-19), so its VAT is the figure approve will demand — requiredCreditNoteVat on what the
 * invoice still has left — and subtotal + VAT is exactly the disputed amount. A gross no proportional split reaches, or
 * more than is left, is refused before any note exists (the savepoint undoes the claim).
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { transaction: vi.fn() }),
  withTransaction: vi.fn(),
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({ createCreditNote: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/invoiceRevenuePosting', () => ({ typedInvoiceCreditState: vi.fn() }));

import { sql } from '@/lib/neon';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { resolveDispute } from '@/modules/accounting/services/ar/disputeService';
import { requiredCreditNoteVat } from '@/modules/accounting/services/ar/creditNoteTypedSplit';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreate = createCreditNote as unknown as MockedFunction<typeof createCreditNote>;
const mockState = typedInvoiceCreditState as unknown as MockedFunction<typeof typedInvoiceCreditState>;
const CO = '11111111-1111-1111-1111-111111111111';
const INV = '22222222-2222-2222-2222-222222222222';
const DSP = '44444444-4444-4444-4444-444444444444';

const wire = (disputed: number) => {
  mockSql.mockReset();
  mockSql
    .mockResolvedValueOnce([{ id: DSP, company_id: CO, customer_invoice_id: INV, status: 'resolved', disputed_amount: String(disputed), reason: 'r' }])
    // A mixed invoice: header 15% on 1500 would be 225, but its VAT is 150 (only the 1000 standard line carries it).
    .mockResolvedValueOnce([{ client_id: 'cl', subtotal: '1500.00', tax_amount: '150.00', tax_rate: '15' }])
    .mockResolvedValueOnce([{ id: DSP, company_id: CO, customer_invoice_id: INV, status: 'resolved', credit_note_id: 'cn-1' }]);
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ id: 'cn-1' } as never);
};
const resolve = () => resolveDispute(CO, DSP, 'u', { mode: 'resolve_with_credit', creditDate: '2026-11-19' });
const passed = () => mockCreate.mock.calls[0]![1] as { subtotal: number; taxAmount: number; taxRate: number };

describe('resolveDispute against a typed invoice', () => {
  beforeEach(() => mockState.mockReset());

  it('splits the disputed gross into a subtotal and exactly the VAT approve will require', async () => {
    mockState.mockResolvedValue({ remainingNet: 1500, remainingVat: 150 });
    wire(165);
    await resolve();
    expect(mockState).toHaveBeenCalledWith(CO, INV);
    const { subtotal, taxAmount } = passed();
    expect([subtotal, taxAmount]).toEqual([150, 15]);
    expect(taxAmount).toBe(requiredCreditNoteVat({ remainingNet: 1500, remainingVat: 150, subtotal }));
  });

  it('after earlier notes: proportional to what is left, here the ten R10.10 lines with 101.00 / 15.20 left', async () => {
    mockState.mockResolvedValue({ remainingNet: 101, remainingVat: 15.2 });
    wire(58.1);
    await resolve();
    expect([passed().subtotal, passed().taxAmount]).toEqual([50.5, 7.6]);
  });

  it('the whole of what is left takes all the VAT left', async () => {
    mockState.mockResolvedValue({ remainingNet: 101, remainingVat: 15.2 });
    wire(116.2);
    await resolve();
    expect([passed().subtotal, passed().taxAmount]).toEqual([101, 15.2]);
  });

  it('more than the invoice has left is refused before any note exists', async () => {
    mockState.mockResolvedValue({ remainingNet: 100, remainingVat: 15 });
    wire(200);
    await expect(resolve()).rejects.toMatchObject({ code: 'DISPUTE_CREDIT_NOT_PROPORTIONAL' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a gross no proportional split reaches is refused, naming the nearest amounts', async () => {
    mockState.mockResolvedValue({ remainingNet: 1500, remainingVat: 150 });
    wire(0.05); // 0.04 + 0.00 = 0.04; 0.05 + 0.01 = 0.06
    await expect(resolve()).rejects.toThrow(/0\.04 or 0\.06/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a legacy invoice keeps the rate split (here the blended 10%, as before)', async () => {
    mockState.mockResolvedValue(null);
    wire(58.1);
    await resolve();
    expect([passed().subtotal, passed().taxAmount]).toEqual([52.82, 5.28]);
  });
});
