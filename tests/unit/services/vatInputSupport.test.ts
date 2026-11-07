/**
 * classifyInputVatSupport (reports/vatInputSupport). The cut (Hein,
 * 2026-09-26) is whether the return's FIGURES would be wrong: a claim that
 * DISAGREES with its document (`amount_mismatch` / `document_over_claimed`)
 * BLOCKS; a claim with no document link at all and never linked
 * (`no_document`), one whose document VAT couldn't be read and clears any
 * bank line (`unreadable_document_vat`), one supported only by the bank
 * line, or a VAT adjustment, is listed but NOT blocking — only a RECORD is
 * missing, not a wrong figure.
 *
 * Breaker fixes (Hein, 2026-09-26, round 2):
 *   1. An unreadable document must not launder a bank over-claim: the
 *      bank-ceiling check still runs when `bankAmount !== null`, even though
 *      the document itself can't be read. Exceeding the ceiling BLOCKS as
 *      `amount_mismatch` on `bank`; only a clearing or absent bank line falls
 *      through to the non-blocking `unreadable_document_vat`.
 *   2. Unlinking a document must not silently downgrade a block to a
 *      warning: `hadDocumentLink` (any `gl_journal_document_links` row ever
 *      recorded for the chain, active or unlinked) makes the "no active
 *      link, no other support" fallback BLOCK as `document_unlinked` instead
 *      of warning as `no_document`. It clears only when a document is linked
 *      again (the normal document checks then apply) or another support
 *      (bank/credit-note/VAT-adjustment) exists — a NEVER-linked journal
 *      still warns as `no_document`.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyInputVatSupport, documentUses, readDocumentVat, type InputVatSupportFacts,
} from '@/modules/accounting/services/reports/vatInputSupport';

const facts = (over: Partial<InputVatSupportFacts>): InputVatSupportFacts => ({
  journalEntryId: 'je', entryNumber: 'JE-1', entryDate: '2026-07-10', source: 'manual', description: '',
  claimedVat: 150, claimedToDate: 150, expenseClaimVat: null, capturedDocumentVat: null, documentClaimedVat: null,
  creditNoteVat: null, vatAdjustment: false, bankAmount: null, hasBankAttachment: false, hadDocumentLink: false,
  hasBankUpload: false, bankDocuments: [], claimDocuments: [],
  ...over,
});
const RATE = 0.15;

describe('readDocumentVat — the extracted VAT, read as the capture pipeline reads a printed amount', () => {
  it.each([[15, 15], ['15.00', 15], ['15,00', 15], ['1 234,50', 1234.5], [null, 0], [undefined, 0]])('%s -> %s', (raw, want) => {
    expect(readDocumentVat(raw)).toBe(want);
  });
  it.each([['fifteen'], ['15,00 VAT'], [''], [{}], [Number.NaN]])('%s is unreadable, never 0', (raw) => {
    expect(readDocumentVat(raw)).toBe('unreadable');
  });
});

describe('documentUses — the query\'s JSON array as uses', () => {
  it('maps vat, total and own; no VAT read is null; unreadable stays unreadable; anything else is empty', () => {
    expect(documentUses([{ vat: '15,00', total: '30', own: 15 }, { vat: null, total: 5, own: 5, lines: 0 }, { vat: 'n/a' }]))
      .toEqual([{ vat: 15, total: 30, own: 15, lines: 0 }, { vat: null, total: 5, own: 5, lines: 0 },
        { vat: 'unreadable', total: 0, own: 0, lines: 0 }]);
    expect(documentUses([{ vat: 15, total: 30, own: 30, lines: '2' }])[0]!.lines).toBe(2);
    expect(documentUses(null)).toEqual([]);
    expect(documentUses('[]')).toEqual([]);
  });
});

describe('classifyInputVatSupport — documents on the bank line and claim lines, as uses', () => {
  const bank = (over: Partial<InputVatSupportFacts>) => classifyInputVatSupport(facts({ claimedVat: 15, claimedToDate: 15, bankAmount: 115, ...over }), RATE);
  it('a slip with room supports the claim; a shared one blocks as over-claimed; a short one blocks as a mismatch', () => {
    expect(bank({ bankDocuments: [{ vat: 15, total: 15, own: 15 }] })).toEqual({ blocking: false, line: null });
    expect(bank({ bankDocuments: [{ vat: 15, total: 30, own: 15 }] }).line?.reason).toBe('document_over_claimed');
    expect(bank({ bankDocuments: [{ vat: 15, total: 30, own: 15 }] }).blocking).toBe(true);
    expect(bank({ bankDocuments: [{ vat: 10, total: 15, own: 15 }] }).line?.reason).toBe('amount_mismatch');
  });
  it('an unreadable slip warns; a short slip beside an upload is supported; the bank ceiling still comes first', () => {
    const w = bank({ bankDocuments: [{ vat: 'unreadable', total: 15, own: 15 }] });
    expect([w.blocking, w.line?.reason]).toEqual([false, 'unreadable_document_vat']);
    expect(bank({ bankDocuments: [{ vat: 10, total: 15, own: 15 }], hasBankUpload: true, hasBankAttachment: true }).line).toBeNull();
    expect(bank({ claimedVat: 20, claimedToDate: 20, bankDocuments: [{ vat: 20, total: 20, own: 20 }] }).line?.supportKind).toBe('bank');
  });
  it('a slip with no VAT read falls back to presence', () => {
    expect(bank({ bankDocuments: [{ vat: null, total: 15, own: 15 }], hasBankAttachment: true }).line).toBeNull();
    expect(bank({ bankDocuments: [{ vat: null, total: 15, own: 15 }] }).line?.reason).toBe('no_tax_invoice');
  });
  it('an expense claim blocks as over-claimed when a slip on it is shared past its VAT', () => {
    const v = classifyInputVatSupport(facts({ claimedVat: 15, claimedToDate: 15, expenseClaimVat: 15,
      claimDocuments: [{ vat: 15, total: 30, own: 15 }] }), RATE);
    expect([v.blocking, v.line?.supportKind, v.line?.reason, v.line?.documentClaimedVat]).toEqual([true, 'expense_claim', 'document_over_claimed', 30]);
  });
});

describe('classifyInputVatSupport', () => {
  it('no link at all: NOT blocking, no_document (Hein, 2026-09-26 — a missing record, not a wrong figure)', () => {
    const v = classifyInputVatSupport(facts({}), RATE);
    expect(v.blocking).toBe(false);
    expect(v.line).toMatchObject({ supportKind: 'none', reason: 'no_document', claimedVat: 150 });
  });

  it('a reduction with no link is not a claim: nothing', () => {
    expect(classifyInputVatSupport(facts({ claimedVat: -40 }), RATE)).toEqual({ blocking: false, line: null });
  });

  it('expense claim: matching VAT is supported; a mismatch blocks', () => {
    expect(classifyInputVatSupport(facts({ expenseClaimVat: 150 }), RATE)).toEqual({ blocking: false, line: null });
    const v = classifyInputVatSupport(facts({ expenseClaimVat: 120 }), RATE);
    expect(v).toMatchObject({ blocking: true, line: { supportKind: 'expense_claim', documentVat: 120, reason: 'amount_mismatch' } });
  });

  it('captured document: its read VAT supports the claim; a claim over it blocks', () => {
    expect(classifyInputVatSupport(facts({ capturedDocumentVat: 150 }), RATE)).toEqual({ blocking: false, line: null });
    expect(classifyInputVatSupport(facts({ capturedDocumentVat: 0 }), RATE).blocking).toBe(true);
  });

  it('one document, one claim: two claims naming a R150 document block as document_over_claimed', () => {
    const v = classifyInputVatSupport(facts({ capturedDocumentVat: 150, documentClaimedVat: 300 }), RATE);
    expect(v).toMatchObject({ blocking: true, line: { reason: 'document_over_claimed', documentVat: 150, documentClaimedVat: 300 } });
  });

  it('an unreadable document VAT is NOT blocking, with its own reason, never as 0 support (Hein, 2026-09-26)', () => {
    const v = classifyInputVatSupport(facts({ capturedDocumentVat: 'unreadable' }), RATE);
    expect(v).toMatchObject({ blocking: false, line: { supportKind: 'captured_document', reason: 'unreadable_document_vat', documentVat: null } });
  });

  it('breaker fix: an unreadable document does not launder a bank over-claim — still BLOCKS as amount_mismatch on bank', () => {
    const v = classifyInputVatSupport(facts({ capturedDocumentVat: 'unreadable', claimedVat: 500, bankAmount: 100 }), RATE);
    expect(v).toMatchObject({ blocking: true, line: { supportKind: 'bank', reason: 'amount_mismatch' } });
  });

  it('an unreadable document with a bank line that CLEARS the ceiling: NOT blocking, unreadable_document_vat', () => {
    const v = classifyInputVatSupport(facts({ capturedDocumentVat: 'unreadable', claimedVat: 15, bankAmount: 115 }), RATE);
    expect(v).toMatchObject({ blocking: false, line: { supportKind: 'captured_document', reason: 'unreadable_document_vat' } });
  });

  it('a chain netting to a claim in the period needs support whatever reinstated it (no link: listed, not blocking)', () => {
    const v = classifyInputVatSupport(facts({ claimedVat: 150, claimedToDate: 150 }), RATE);
    expect(v.blocking).toBe(false);
    expect(v.line).toMatchObject({ reason: 'no_document' });
  });

  it('an expense claim is compared on its chain to date: a claim reversed earlier and reinstated still ties', () => {
    expect(classifyInputVatSupport(facts({ claimedVat: 15, claimedToDate: 15, expenseClaimVat: 15 }), RATE)).toEqual({ blocking: false, line: null });
    expect(classifyInputVatSupport(facts({ claimedVat: 15, claimedToDate: 30, expenseClaimVat: 15 }), RATE).blocking).toBe(true);
  });

  it('supplier credit note: the reduction matches its tax; a short reduction blocks', () => {
    expect(classifyInputVatSupport(facts({ claimedVat: -15, creditNoteVat: 15 }), RATE)).toEqual({ blocking: false, line: null });
    expect(classifyInputVatSupport(facts({ claimedVat: -10, creditNoteVat: 15 }), RATE).blocking).toBe(true);
  });

  it('bank only: listed as no tax invoice on file, NOT blocking', () => {
    const v = classifyInputVatSupport(facts({ claimedVat: 15, bankAmount: 115 }), RATE);
    expect(v).toMatchObject({ blocking: false, line: { supportKind: 'bank', reason: 'no_tax_invoice' } });
  });

  it('bank: VAT above rate/(1+rate) of the money blocks', () => {
    const v = classifyInputVatSupport(facts({ claimedVat: 16, bankAmount: 115 }), RATE);
    expect(v).toMatchObject({ blocking: true, line: { supportKind: 'bank', documentVat: 15, reason: 'amount_mismatch' } });
  });

  it('item 2: an invoice attached to the bank line fully supports the claim — off the list entirely', () => {
    const v = classifyInputVatSupport(facts({ claimedVat: 15, bankAmount: 115, hasBankAttachment: true }), RATE);
    expect(v).toEqual({ blocking: false, line: null });
  });

  it('item 2: an attachment does not excuse a genuine over-claim above the bank ceiling', () => {
    const v = classifyInputVatSupport(facts({ claimedVat: 16, bankAmount: 115, hasBankAttachment: true }), RATE);
    expect(v).toMatchObject({ blocking: true, line: { supportKind: 'bank', reason: 'amount_mismatch' } });
  });

  it('a document link outranks the bank: a matched receipt is supported by the receipt', () => {
    expect(classifyInputVatSupport(facts({ capturedDocumentVat: 150, bankAmount: 1150 }), RATE))
      .toEqual({ blocking: false, line: null });
  });

  it('VAT adjustment: listed, not blocking', () => {
    const v = classifyInputVatSupport(facts({ vatAdjustment: true }), RATE);
    expect(v).toMatchObject({ blocking: false, line: { supportKind: 'vat_adjustment', reason: 'no_tax_invoice' } });
  });

  it('breaker fix: a journal that had a document link, now has none and no other support, BLOCKS as document_unlinked', () => {
    const v = classifyInputVatSupport(facts({ hadDocumentLink: true }), RATE);
    expect(v).toMatchObject({ blocking: true, line: { supportKind: 'none', reason: 'document_unlinked' } });
  });

  it('a NEVER-linked journal with no support still warns as no_document, not document_unlinked', () => {
    const v = classifyInputVatSupport(facts({ hadDocumentLink: false }), RATE);
    expect(v).toMatchObject({ blocking: false, line: { supportKind: 'none', reason: 'no_document' } });
  });

  it('a relink to a matching document clears document_unlinked — the normal document check applies', () => {
    const v = classifyInputVatSupport(facts({ hadDocumentLink: true, capturedDocumentVat: 150 }), RATE);
    expect(v).toEqual({ blocking: false, line: null });
  });

  it('a relink to an over-claiming document still blocks — as document_over_claimed, not document_unlinked', () => {
    const v = classifyInputVatSupport(facts({ hadDocumentLink: true, capturedDocumentVat: 150, documentClaimedVat: 300 }), RATE);
    expect(v).toMatchObject({ blocking: true, line: { reason: 'document_over_claimed' } });
  });

  it('a previously-linked journal with a clearing bank line is "other support" — not document_unlinked', () => {
    const v = classifyInputVatSupport(facts({ hadDocumentLink: true, claimedVat: 15, bankAmount: 115 }), RATE);
    expect(v).toMatchObject({ blocking: false, line: { supportKind: 'bank', reason: 'no_tax_invoice' } });
  });
});
