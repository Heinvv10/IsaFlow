/**
 * approve_credit_note / cancel_credit_note / list_credit_notes / get_credit_note —
 * split out of creditNoteTools.test.ts (whose header says what is pinned and why)
 * for the 300-line limit; same harness, assertions unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { COMPANY, CUST_INV, NOTE, KEY, ctx, parseOk, errText, draftNote } from './creditNoteTools.harness';
import {
  getCreditNotes, getCreditNoteById, approveCreditNote, cancelCreditNote,
} from '@/modules/accounting/services/ar/creditNoteService';
import { listCreditNoteAllocations } from '@/modules/accounting/services/shared/creditNoteFifo';
import { listCreditNotesTool, getCreditNoteTool } from '@/lib/mcp/tools/creditNotes';
import { approveCreditNoteTool, cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';

describe('approve_credit_note', () => {
  it('refuses a non-draft note from a READ, without calling the service', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue({ ...draftNote, status: 'applied' } as never);
    const r = await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(errText(r)).toContain('status: applied');
    expect(approveCreditNote).not.toHaveBeenCalled();
  });

  it('answers a missing note with the generic miss text', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(null as never);
    const r = await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(errText(r)).toBe('Not found');
  });

  it('stamps mcp:approve_credit_note:v1 so the posting shows in list_agent_postings', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
    vi.mocked(approveCreditNote).mockResolvedValue({
      ...draftNote, status: 'approved', glJournalEntryId: 'je-1',
    } as never);

    await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(approveCreditNote).toHaveBeenCalledWith(
      COMPANY, NOTE, expect.any(String),
      { postingAgent: 'mcp:approve_credit_note:v1', actorType: 'agent', actorTokenJti: 'jti',
        autoApply: 'fifo' },
    );
  });

  it('names every document the note settled, and what is left on account', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);

    vi.mocked(approveCreditNote).mockResolvedValue({
      ...draftNote, status: 'partially_applied', totalAmount: 1150, appliedAmount: 400,
      customerInvoiceId: CUST_INV, glJournalEntryId: 'je-1',
    } as never);
    vi.mocked(listCreditNoteAllocations).mockResolvedValue([{ invoiceId: CUST_INV, amount: 400 }]);
    expect(parseOk(await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx())))
      .toMatchObject({
        status: 'partially_applied',
        applied_amount: 400,
        unapplied_amount: 750,
        applied_to_invoice_ids: [{ invoice_id: CUST_INV, amount: 400 }],
      });

    vi.mocked(approveCreditNote).mockResolvedValue({
      ...draftNote, status: 'approved', totalAmount: 1150, appliedAmount: 0, glJournalEntryId: 'je-1',
    } as never);
    vi.mocked(listCreditNoteAllocations).mockResolvedValue([]);
    expect(parseOk(await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx())))
      .toMatchObject({ status: 'approved', applied_amount: 0, applied_to_invoice_ids: [] });
  });

  it('passes auto_apply "none" through, and refuses a value that is neither', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
    vi.mocked(approveCreditNote).mockResolvedValue({
      ...draftNote, status: 'approved', totalAmount: 1150, appliedAmount: 0, glJournalEntryId: 'je-1',
    } as never);
    vi.mocked(listCreditNoteAllocations).mockResolvedValue([]);

    await approveCreditNoteTool.handler({ credit_note_id: NOTE, auto_apply: 'none', ...KEY }, ctx());
    expect(vi.mocked(approveCreditNote).mock.calls[0]![3]).toMatchObject({ autoApply: 'none' });

    // Coercing an unknown value to the default would spend the credit for an
    // agent that asked for the opposite.
    const bad = await approveCreditNoteTool.handler(
      { credit_note_id: NOTE, auto_apply: 'oldest', ...KEY }, ctx(),
    );
    expect(errText(bad)).toContain('auto_apply must be one of');
  });

  it('RETHROWS a service failure instead of flattening it into a tool error', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
    vi.mocked(approveCreditNote).mockRejectedValue(new Error('no vat_output account'));
    await expect(approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx()))
      .rejects.toThrow('no vat_output account');
  });
});

describe('cancel_credit_note', () => {
  it('refuses a draft — there is no journal to reverse', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
    const r = await cancelCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(errText(r)).toContain('status: draft');
    expect(cancelCreditNote).not.toHaveBeenCalled();
  });

  it('accepts both approved and applied, stamping the reversal', async () => {
    for (const status of ['approved', 'applied'] as const) {
      vi.clearAllMocks();
      vi.mocked(getCreditNoteById).mockResolvedValue({ ...draftNote, status } as never);
      vi.mocked(cancelCreditNote).mockResolvedValue({ ...draftNote, status: 'cancelled' } as never);

      const out = parseOk(
        await cancelCreditNoteTool.handler({ credit_note_id: NOTE, reason: 'duplicate', ...KEY }, ctx()),
      );
      expect(out.status).toBe('cancelled');
      expect(cancelCreditNote).toHaveBeenCalledWith(
        COMPANY, NOTE, expect.any(String), 'duplicate',
        { postingAgent: 'mcp:cancel_credit_note:v1', actorType: 'agent', actorTokenJti: 'jti' },
      );
    }
  });
});

describe('read tools', () => {
  it('list_credit_notes rejects an unknown type or status before querying', async () => {
    expect(errText(await listCreditNotesTool.handler({ type: 'vendor' }, ctx()))).toContain('type must be');
    expect(errText(await listCreditNotesTool.handler({ status: 'posted' }, ctx()))).toContain('status must be');
    expect(getCreditNotes).not.toHaveBeenCalled();
  });

  it('list_credit_notes clamps limit to 200 and passes the filters through', async () => {
    vi.mocked(getCreditNotes).mockResolvedValue({ creditNotes: [], total: 0 } as never);
    await listCreditNotesTool.handler({ type: 'supplier', status: 'applied', limit: 5000 }, ctx());
    expect(getCreditNotes).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ type: 'supplier', status: 'applied', limit: 200 }),
    );
  });

  it('get_credit_note answers a miss generically — never an existence oracle', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(null as never);
    expect(errText(await getCreditNoteTool.handler({ credit_note_id: NOTE }, ctx()))).toBe('Not found');
  });

  it('compacts a note to the actionable fields, including the ledger proof', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue({
      ...draftNote, status: 'applied', customerInvoiceId: CUST_INV, glJournalEntryId: 'je-1',
    } as never);
    const out = parseOk(await getCreditNoteTool.handler({ credit_note_id: NOTE }, ctx()));
    expect(out).toMatchObject({
      id: NOTE, type: 'customer', status: 'applied',
      customer_invoice_id: CUST_INV, gl_journal_entry_id: 'je-1', total_amount: 115,
    });
  });
});
