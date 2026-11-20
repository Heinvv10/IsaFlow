/**
 * createCreditNote stores the VAT creditNoteTypedVat gives a customer note linked to a TYPED invoice (the required
 * figure, at the invoice's rate) instead of the rate on its subtotal; with no typed answer (null) it is the existing
 * rule, unchanged; a refusal is raised before the INSERT. The rule itself: creditNoteTypedVat.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockSql, COMPANY_ID, USER_ID, creditNoteRow } from './creditNoteService.harness';

const typed = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ar/creditNoteTypedVat', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteTypedVat')>()), typedCreditNoteVat: typed,
}));
vi.mock('@/modules/accounting/services/ar/creditNoteLinkService', () => ({ validateCreditNoteLinks: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/ar/creditNoteHeaderTags', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteHeaderTags')>()),
  creditNoteHeaderTags: vi.fn(async () => undefined),
}));

import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';

const INV = '44444444-4444-4444-8444-444444444444';
// INSERT INTO credit_notes VALUES: … 8 subtotal, 9 tax_rate, 10 tax_amount, 11 total_amount
const inserted = () => {
  const call = mockSql.mock.calls.find((c) => String((c[0] as readonly string[]).join('')).includes('INSERT INTO credit_notes'));
  const v = (call as unknown[]).slice(1);
  return { subtotal: v[8], taxRate: v[9], taxAmount: v[10], total: v[11] };
};
const note = (over: Record<string, unknown> = {}) => ({ type: 'customer' as const, clientId: 'c', customerInvoiceId: INV, creditDate: '2026-09-20', subtotal: 150, ...over });

describe('createCreditNote and a typed invoice', () => {
  it('stores the required figure at the invoice\'s rate (15.00 on 150, not 22.50)', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    typed.mockResolvedValueOnce({ taxAmount: 15, taxRate: 15 });
    await createCreditNote(COMPANY_ID, note(), USER_ID);
    expect(typed).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({ customerInvoiceId: INV, subtotal: 150 }));
    expect(inserted()).toEqual({ subtotal: 150, taxRate: 15, taxAmount: 15, total: 165 });
  });

  it('with no typed answer the existing rule stands: the rate on the subtotal', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    typed.mockResolvedValueOnce(null);
    await createCreditNote(COMPANY_ID, note({ taxRate: 15 }), USER_ID);
    expect(inserted()).toEqual({ subtotal: 150, taxRate: 15, taxAmount: 22.5, total: 172.5 });
  });

  it('given only a figure of 0, the note is stored at rate 0 (it was 15 with VAT 0; #1701)', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    typed.mockResolvedValueOnce(null);
    await createCreditNote(COMPANY_ID, note({ taxAmount: 0 }), USER_ID);
    expect(inserted()).toEqual({ subtotal: 150, taxRate: 0, taxAmount: 0, total: 150 });
  });

  it.each([[33.3, 5, 38.3], [3.3, 0.5, 3.8], [43.3, 6.5, 49.8], [100.3, 15.05, 115.35]])(
    'a rate gives its VAT in exact cents: %s at 15 percent stores %s, total %s (#1701 round 3 M2; the float stored 4.99 on 33.30)',
    async (subtotal, taxAmount, total) => {
      mockSql.mockResolvedValue([creditNoteRow()]);
      typed.mockResolvedValueOnce(null);
      await createCreditNote(COMPANY_ID, note({ customerInvoiceId: undefined, subtotal, taxRate: 15 }), USER_ID);
      expect(inserted()).toEqual({ subtotal, taxRate: 15, taxAmount, total });
    });

  it('a refusal is raised before the INSERT', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    typed.mockRejectedValueOnce(new CreditNoteVatSplitRefusal('must carry VAT of 15.00'));
    await expect(createCreditNote(COMPANY_ID, note({ taxRate: 15 }), USER_ID)).rejects.toBeInstanceOf(CreditNoteVatSplitRefusal);
    expect(mockSql.mock.calls.some((c) => String((c[0] as readonly string[]).join('')).includes('INSERT INTO credit_notes'))).toBe(false);
  });
});
