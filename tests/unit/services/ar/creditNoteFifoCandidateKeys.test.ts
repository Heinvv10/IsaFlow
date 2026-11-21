/**
 * A FIFO approval takes the credit-note key of every open invoice it may walk to, before its journal (#1701 review
 * round 8). An approval of a note linked to a typed invoice with auto_apply 'none' reads that invoice's remaining
 * credit under the key alone; a FIFO walk that read it under the invoice ROW lock only let both spend the same R115.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockCreateJournalEntry, setNote, creditNoteRow, COMPANY_ID, CN_ID, USER_ID } from './creditNoteService.harness';
import { lockOpenInvoicesCreditNotes } from '@/modules/accounting/services/ar/creditNotePostingChecks';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';

describe('approveCreditNote takes the FIFO candidates\' keys', () => {
  it('a customer FIFO note: the client\'s open invoices\' keys, before the journal', async () => {
    const order: string[] = [];
    vi.mocked(lockOpenInvoicesCreditNotes).mockImplementation(async () => { order.push('keys'); });
    mockCreateJournalEntry.mockImplementationOnce((async () => { order.push('journal'); return { id: 'je' }; }) as never);
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved' })]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(lockOpenInvoicesCreditNotes).toHaveBeenCalledWith(COMPANY_ID, 'client-uuid');
    expect(order).toEqual(['keys', 'journal']);
  });

  it.each(['none', 'linked'] as const)('auto_apply %s walks nothing, so takes no candidate key', async (autoApply) => {
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved' })]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { autoApply });
    expect(lockOpenInvoicesCreditNotes).not.toHaveBeenCalled();
  });
});
