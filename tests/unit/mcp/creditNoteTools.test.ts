/**
 * list_credit_notes / get_credit_note / create_credit_note /
 * approve_credit_note / cancel_credit_note.
 *
 * What is worth pinning:
 *
 *  - create answers tenant AND counterparty ownership BEFORE the first write.
 *    Every id it accepts is a bare foreign key with no (id, company_id)
 *    constraint, and `approveCreditNote` AUTO-APPLIES a linked note — so a note
 *    naming customer A but linked to customer B's invoice would pay down B's
 *    debt with A's credit, silently and permanently.
 *  - cross-type argument combinations refuse rather than being written as
 *    NULLs, which would create a note that approves into a journal with
 *    nothing to apply against.
 *  - a non-positive subtotal refuses: it inverts the note's GL at approve,
 *    turning a credit note into an invoice wearing the wrong document type.
 *  - approve/cancel stamp `mcp:<tool>:v1`. Without it createJournalEntry falls
 *    back to defaultHumanMeta(userId), labelling agent work as the token
 *    owner's own and hiding it from list_agent_postings.
 *  - approve/cancel answer their status refusals from a READ and RETHROW
 *    everything else: a refusal is audited with a NULL idempotency key, so a
 *    catch-and-return after the journal posted would let the agent's retry post
 *    the note a second time.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  COMPANY, CUSTOMER, SUPPLIER, CUST_INV, SUPP_INV, NOTE, KEY, ctx, parseOk, errText, draftNote,
} from './creditNoteTools.harness';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { validateCreditNoteLinks, findOpenDuplicateDraft } from '@/modules/accounting/services/ar/creditNoteLinkService';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';

// approve / cancel / the read tools: creditNoteToolsApprove.test.ts (same harness).

describe('create_credit_note — pre-write guards', () => {
  const base = { type: 'customer', credit_date: '2026-06-30', subtotal: 100, ...KEY };

  it('refuses a non-positive subtotal before any ownership read or write', async () => {
    for (const subtotal of [0, -100]) {
      const r = await createCreditNoteTool.handler({ ...base, subtotal, client_id: CUSTOMER }, ctx());
      expect(errText(r)).toContain('subtotal must be a positive number');
    }
    expect(validateCreditNoteLinks).not.toHaveBeenCalled();
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('refuses cross-type arguments rather than writing them as NULLs', async () => {
    const cust = await createCreditNoteTool.handler(
      { ...base, client_id: CUSTOMER, supplier_invoice_id: SUPP_INV }, ctx(),
    );
    expect(errText(cust)).toContain('customer credit note cannot carry');

    const supp = await createCreditNoteTool.handler(
      { ...base, type: 'supplier', supplier_id: SUPPLIER, customer_invoice_id: CUST_INV }, ctx(),
    );
    expect(errText(supp)).toContain('supplier credit note cannot carry');

    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('refuses a tax_rate outside 0..100', async () => {
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, tax_rate: 150 }, ctx());
    expect(errText(r)).toContain('tax_rate must be between 0 and 100');
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('surfaces the link refusal and never writes — a foreign or mismatched id', async () => {
    vi.mocked(validateCreditNoteLinks).mockResolvedValue(
      'customer_invoice_id belongs to a different customer than client_id',
    );
    const r = await createCreditNoteTool.handler(
      { ...base, client_id: CUSTOMER, customer_invoice_id: CUST_INV }, ctx(),
    );
    expect(errText(r)).toContain('different customer');
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('validates links BEFORE calling the service, not after', async () => {
    const order: string[] = [];
    vi.mocked(validateCreditNoteLinks).mockImplementation(async () => {
      order.push('validate');
      return null;
    });
    vi.mocked(createCreditNote).mockImplementation(async () => {
      order.push('create');
      return draftNote as never;
    });
    await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER }, ctx());
    expect(order).toEqual(['validate', 'create']);
  });

  it('passes a supplier UUID straight through — never coerced to a number', async () => {
    vi.mocked(createCreditNote).mockResolvedValue({ ...draftNote, type: 'supplier' } as never);
    await createCreditNoteTool.handler(
      { type: 'supplier', credit_date: '2026-06-30', subtotal: 100, supplier_id: SUPPLIER, ...KEY },
      ctx(),
    );
    expect(createCreditNote).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ type: 'supplier', supplierId: SUPPLIER }),
      expect.any(String),
      { postingAgent: 'mcp:create_credit_note:v1', actorType: 'agent', actorTokenJti: 'jti' },
    );
  });

  it('refuses an identical open draft and names it, so a fresh key cannot duplicate', async () => {
    vi.mocked(findOpenDuplicateDraft).mockResolvedValue('dupe-id-1');
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER }, ctx());
    expect(errText(r)).toContain('dupe-id-1');
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  /**
   * Two genuine returns to one supplier on one day for one amount are two
   * credits. The refusal used to say "change the date, amount or reason" — but
   * reason is not part of the duplicate key, so the only way through was to
   * alter the date or the amount: falsify the document to pass the guard.
   *
   * The override must NAME the draft it overrides (adversarial review): a bare
   * boolean could be sent blind on a first call, after which every fresh-key
   * retry would mint another identical note — the case the guard exists for.
   */
  const DUP = '0b0b0b0b-0000-4000-8000-000000000001';
  const NEWER_DUP = '0b0b0b0b-0000-4000-8000-000000000002';

  it('tells the truth about the way through: duplicate_of naming the draft, not a changed reason', async () => {
    vi.mocked(findOpenDuplicateDraft).mockResolvedValue(DUP);
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, reason: 'other' }, ctx());
    expect(errText(r)).toContain(`duplicate_of: "${DUP}"`);
    expect(errText(r)).not.toContain('reason');
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('creates a genuine second credit when duplicate_of names the current identical draft', async () => {
    vi.mocked(findOpenDuplicateDraft).mockResolvedValue(DUP);
    vi.mocked(createCreditNote).mockResolvedValue(draftNote as never);
    const out = parseOk(await createCreditNoteTool.handler(
      { ...base, client_id: CUSTOMER, duplicate_of: DUP }, ctx(),
    ));
    expect(out).toMatchObject({ id: NOTE, status: 'draft' });
  });

  it('refuses a stale duplicate_of — a fresh-key retry after the override cannot mint a third', async () => {
    // The override created NEWER_DUP; the retry still names DUP.
    vi.mocked(findOpenDuplicateDraft).mockResolvedValue(NEWER_DUP);
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, duplicate_of: DUP }, ctx());
    expect(errText(r)).toContain(NEWER_DUP);
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('refuses duplicate_of when there is no identical draft — it cannot be sent blind', async () => {
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, duplicate_of: DUP }, ctx());
    expect(errText(r)).toContain('no longer an identical open draft');
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  /**
   * Re-review LOW: the named draft may have been APPROVED between the refusal
   * and the retry. Telling the agent to "omit duplicate_of" walked it into a
   * second note identical to an approved one — which the draft-only guard can
   * no longer see. The refusal must say the draft is gone and why that matters.
   */
  it('does not tell the agent to simply drop duplicate_of once the named draft has moved on', async () => {
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, duplicate_of: DUP }, ctx());
    const text = errText(r);
    expect(text).toContain(DUP);
    expect(text).toContain('approved or cancelled');
    expect(text).toContain('get_credit_note');
    expect(text).not.toContain('Omit duplicate_of');
  });

  it('refuses a duplicate_of that is not a uuid, before any read', async () => {
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, duplicate_of: 'yes' }, ctx());
    expect(r.isError).toBe(true);
    expect(findOpenDuplicateDraft).not.toHaveBeenCalled();
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('ignores the old boolean: allow_duplicate no longer opens the guard', async () => {
    vi.mocked(findOpenDuplicateDraft).mockResolvedValue(DUP);
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, allow_duplicate: true }, ctx());
    expect(r.isError).toBe(true);
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('checks for a duplicate using the VAT-inclusive total, not the subtotal', async () => {
    vi.mocked(createCreditNote).mockResolvedValue(draftNote as never);
    await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER }, ctx());
    // subtotal 100 at the default 15% is a 115 note; matching on 100 would let
    // two notes with different VAT rates collide, and miss a real repeat.
    expect(findOpenDuplicateDraft).toHaveBeenCalledWith(COMPANY, expect.anything(), 115);
  });

  it('creates a draft and reports the computed VAT totals', async () => {
    vi.mocked(createCreditNote).mockResolvedValue(draftNote as never);
    const out = parseOk(
      await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER }, ctx()),
    );
    expect(out).toMatchObject({ status: 'draft', subtotal: 100, tax_amount: 15, total_amount: 115 });
  });
});
