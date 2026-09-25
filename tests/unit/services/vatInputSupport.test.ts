/**
 * classifyInputVatSupport (reports/vatInputSupport): a claim with nothing
 * behind it BLOCKS; a claim that disagrees with its document BLOCKS; a claim
 * supported only by the bank line or a VAT adjustment is listed, not blocking.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyInputVatSupport, type InputVatSupportFacts,
} from '@/modules/accounting/services/reports/vatInputSupport';

const facts = (over: Partial<InputVatSupportFacts>): InputVatSupportFacts => ({
  journalEntryId: 'je', entryNumber: 'JE-1', entryDate: '2026-07-10', source: 'manual', description: '',
  claimedVat: 150, expenseClaimVat: null, capturedDocumentVat: null, creditNoteVat: null,
  vatAdjustment: false, bankAmount: null, ...over,
});
const RATE = 0.15;

describe('classifyInputVatSupport', () => {
  it('no link at all: blocking, no_document', () => {
    const v = classifyInputVatSupport(facts({}), RATE);
    expect(v.blocking).toBe(true);
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

  it('a document link outranks the bank: a matched receipt is supported by the receipt', () => {
    expect(classifyInputVatSupport(facts({ capturedDocumentVat: 150, bankAmount: 1150 }), RATE))
      .toEqual({ blocking: false, line: null });
  });

  it('VAT adjustment: listed, not blocking', () => {
    const v = classifyInputVatSupport(facts({ vatAdjustment: true }), RATE);
    expect(v).toMatchObject({ blocking: false, line: { supportKind: 'vat_adjustment', reason: 'no_tax_invoice' } });
  });
});
