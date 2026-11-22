/** createCreditNote refuses, before any write, a note whose computed total (subtotal + VAT) NUMERIC(15,2) cannot hold (#1701 round 11 nit c). */
import { describe, expect, it } from 'vitest';
import { mockSql, COMPANY_ID, USER_ID, creditNoteRow } from './creditNoteService.harness';
import { createCreditNote, CreditNoteLinkError } from '@/modules/accounting/services/ar/creditNoteService';

describe('createCreditNote: the total in range', () => {
  it('9 999 999 999 999.00 at 15% would total 11 499 999 999 998.85: refused as a link error (REST 400), nothing inserted', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    await expect(createCreditNote(COMPANY_ID, { type: 'supplier', supplierId: '55555555-5555-4555-8555-555555555555', creditDate: '2026-07-04',
      subtotal: 9_999_999_999_999, taxRate: 15 }, USER_ID)).rejects.toBeInstanceOf(CreditNoteLinkError);
    expect(mockSql.mock.calls.some((c) => (c[0] as readonly string[]).join('').includes('INSERT INTO credit_notes'))).toBe(false);
  });
  it('round 12 boundary: a total of exactly 9 999 999 999 999.99 is accepted; one cent more is refused', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    const supplier = { type: 'supplier' as const, supplierId: '55555555-5555-4555-8555-555555555555', creditDate: '2026-07-04' };
    await expect(createCreditNote(COMPANY_ID, { ...supplier, subtotal: 9_999_999_999_999.98, taxAmount: 0.01 }, USER_ID)).resolves.toBeTruthy();
    mockSql.mockClear();
    await expect(createCreditNote(COMPANY_ID, { ...supplier, subtotal: 9_999_999_999_999.99, taxAmount: 0.01 }, USER_ID)).rejects.toBeInstanceOf(CreditNoteLinkError);
    expect(mockSql.mock.calls.some((c) => (c[0] as readonly string[]).join('').includes('INSERT INTO credit_notes'))).toBe(false);
  });
});
