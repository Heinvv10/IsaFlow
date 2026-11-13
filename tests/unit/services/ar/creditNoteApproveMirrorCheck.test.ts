/**
 * Migration 988 (review round 1, quality #4): approveCreditNote calls the mirror_bill re-check with the note's own
 * fields, under the bill's credit-note key, BEFORE anything is written — a refusal posts no journal. The re-check
 * itself: tests/unit/services/ap/supplierCreditNoteMirrorApprove.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockSql, mockCreateJournalEntry, COMPANY_ID, CN_ID, USER_ID, creditNoteRow } from './creditNoteService.harness';

const { order } = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove')>()),
  assertMirroredNoteVatStands: vi.fn(async () => { order.push('recheck'); }),
}));

import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import {
  MirroredNoteVatRefusal, assertMirroredNoteVatStands,
} from '@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove';

const BILL = 'cccccccc-0000-4000-8000-cccccccccccc';
const note = (over: Record<string, unknown> = {}) => creditNoteRow({
  type: 'supplier', client_id: null, supplier_id: 'supplier-uuid', supplier_invoice_id: BILL,
  vat_basis: 'mirror_bill', subtotal: '500.00', tax_amount: '75.00', total_amount: '575.00', ...over,
});

beforeEach(() => {
  order.length = 0;
  vi.mocked(assertMirroredNoteVatStands).mockClear();
  mockSql.mockImplementation((() => Promise.resolve([])) as never);
});

describe('approveCreditNote: the mirror_bill re-check', () => {
  it('is called with the note\'s own fields, before any journal is built', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note() as never);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID).catch(() => 'later steps are not this suite\'s');
    expect(assertMirroredNoteVatStands).toHaveBeenCalledWith(COMPANY_ID, {
      id: CN_ID, number: expect.any(String), type: 'supplier', subtotal: 500, taxAmount: 75, billId: BILL, vatBasis: 'mirror_bill',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), ackMatches: null,
    });
    expect(order).toEqual(['recheck']);
    expect(vi.mocked(assertMirroredNoteVatStands).mock.invocationCallOrder[0]!)
      .toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  it('a refusal posts nothing', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note() as never);
    vi.mocked(assertMirroredNoteVatStands).mockRejectedValueOnce(new MirroredNoteVatRefusal('VAT_ALREADY_REVERSED: x'));
    await expect(approveCreditNote(COMPANY_ID, CN_ID, USER_ID)).rejects.toBeInstanceOf(MirroredNoteVatRefusal);
    expect(mockCreateJournalEntry).not.toHaveBeenCalled();
  });

  it('a pre-988 row (no vat_basis) is passed as rate', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ vat_basis: undefined }) as never);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID).catch(() => 'later steps are not this suite\'s');
    expect(vi.mocked(assertMirroredNoteVatStands).mock.calls[0]![1]).toMatchObject({ vatBasis: 'rate' });
  });
});
