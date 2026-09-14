/**
 * K-076 round 13 — the gate measures AMOUNTS, not labels.
 *
 * Six rounds decided "one printed total" over a candidate set defined by
 * LABELS, and each reviewer found a payable printed under a label the
 * vocabulary lacked: the slip then yielded one candidate, the plain `Total`,
 * and posted it. `unexplainedLargerFigure` needs no vocabulary — a figure
 * larger than the total refuses, unless a tender and the change printed after
 * it net to the total — so the next unknown label cannot beat it.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { unexplainedLargerFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { extractTotalCandidates } from '@/modules/accounting/services/core/ocrAmountReconciliation';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';
import { isAmbiguousTotal, unattendedPostingRefusal } from '@/modules/accounting/services/core/unattendedPostingGate';
import { validateReceiptExtraction } from '@/modules/accounting/services/bank/receiptToJournalService';

const TIP_CARD = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nTip 23.00\nCARD 253.00';

describe('K-076 unexplainedLargerFigure', () => {
  it('finds a larger figure below the total, whatever it is labelled', () => {
    expect(unexplainedLargerFigure(TIP_CARD, 230)).toBe(253);
    expect(unexplainedLargerFigure('Total 230.00\nGratuity 23.00\nVerskuldig 253.00', 230)).toBe(253);
  });

  it('finds a larger figure ABOVE the total — a payable over a VAT-analysis block', () => {
    expect(unexplainedLargerFigure('SALE 253.00\nCARD 253.00\nVAT ANALYSIS\nSub Total 200.00\nVAT 30.00\nTotal 230.00', 230)).toBe(253);
  });

  it('is null when the total is the largest figure printed', () => {
    expect(unexplainedLargerFigure('Sub Total 1000.00\nVAT 150.00\nTotal 1150.00\nCARD 1150.00\nAmount Paid 0.00', 1150)).toBeNull();
    expect(unexplainedLargerFigure('Sub Total 1000.00\nVAT 150.00\nAmount Paid 0.00\nBalance Due 1150.00', 1150)).toBeNull();
    expect(unexplainedLargerFigure('TOTAL 142.98\nVAT INCLUDED 18.65\nCARD 142.98', 142.98)).toBeNull();
  });

  it('accepts a tender only when the NEXT figure is change that nets to the total', () => {
    expect(unexplainedLargerFigure('TOTAL 253.00\nCASH 300.00\nCHANGE 47.00', 253)).toBeNull();
    expect(unexplainedLargerFigure('TOTAL 23.00\nCASH 200.00\nCHANGE 177.00', 23)).toBeNull();
    expect(unexplainedLargerFigure('TOTAL 253.00\nCASH 300.00', 253)).toBe(300);
    expect(unexplainedLargerFigure('TOTAL 253.00\nCASH 300.00\nCHANGE 40.00', 253)).toBe(300);
    expect(unexplainedLargerFigure('TOTAL 253.00\nCASH 300.00\nRounding 0.00\nCHANGE 47.00', 253)).toBe(300);
    // A figure that nets but carries no change label is not change.
    expect(unexplainedLargerFigure('TOTAL 253.00\nCASH 300.00\nTip 47.00', 253)).toBe(300);
  });

  it('reads the change label between figures on one line', () => {
    expect(unexplainedLargerFigure('TOTAL 253.00\nCash 300.00 Change 47.00', 253)).toBeNull();
    // The label has to stand in front of the change figure itself.
    expect(unexplainedLargerFigure('TOTAL 253.00\nChange given: Cash 300.00 47.00', 253)).toBe(300);
  });

  it('reads a space-grouped figure at the end of its line, not an item row', () => {
    expect(unexplainedLargerFigure('Total 1 150.00\nPlease Pay 1 265.00', 1150)).toBe(1265);
    expect(unexplainedLargerFigure('USB Cable 1 149.00 149.00\nTotal 149.00', 149)).toBeNull();
    expect(unexplainedLargerFigure('Total 1,150.00\nPlease Pay 1,265.00', 1150)).toBe(1265);
  });

  it('ignores figures with no decimal part, dates and rates', () => {
    const text = 'VAT No 4123456789\nDate 01.09.2026\nCard ************1234\nVAT 15.00%\nTotal 10.00';
    expect(unexplainedLargerFigure(text, 10)).toBeNull();
  });
});

describe('K-076 the gate and the AP routes refuse a larger figure', () => {
  const stored = (rawText: string, o: Partial<ExtractedDocument> = {}): ExtractedDocument => ({
    documentType: 'receipt', vendorName: 'Ocean Basket', vendorVatNumber: null, vendorAddress: null,
    vendorBankDetails: null, customerName: null, customerVatNumber: null, date: '2026-09-01',
    dueDate: null, paymentTerms: null, referenceNumber: 'R1', purchaseOrderRef: null, currency: 'ZAR',
    // Round 20: the header names the document a purchase (`purchaseTitle`).
    subtotal: 200, vatAmount: 30, vatRate: 15, totalAmount: 230, lineItems: [], rawText: `TAX INVOICE\n${rawText}`,
    confidence: 1, warnings: [], extractionMethod: 'vlm', ...o,
  });

  it('refuses a stored extraction whose text prints a larger figure, with no warning stored', () => {
    expect(unattendedPostingRefusal(stored(TIP_CARD))).toMatch(/prints 253\.00, more than the total/);
  });

  it('still posts the same stored extraction when the card pays the total', () => {
    expect(unattendedPostingRefusal(stored('Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nCARD 230.00'))).toBeNull();
  });

  it('isAmbiguousTotal holds a one-candidate slip with a larger figure', () => {
    expect(isAmbiguousTotal({ rawText: TIP_CARD, warnings: [] })).toBe(true);
    expect(isAmbiguousTotal({ rawText: 'Total 230.00\nCARD 230.00', warnings: [] })).toBe(false);
  });

  it('the reader tells the person, under the reconciliation prefix', () => {
    const read = extractAmounts(TIP_CARD);
    expect(read.totalAmount).toBe(230);
    expect(read.warnings.join(' ')).toMatch(/printed 253\.00/);
  });
});

describe('K-076 a zero balance is not the payable', () => {
  it('drops a zero beside a non-zero figure, and keeps a negative one', () => {
    expect(extractTotalCandidates('Total 1150.00\nAmount Paid 1150.00\nBalance Due 0.00')).toEqual([1150]);
    // A negative is KEPT: dropping it read a refund slip's `Refund Total
    // 499.00` as the payable under `TOTAL -499.00` (review r13 HIGH-1).
    expect(extractTotalCandidates('Total 1150.00\nBalance Due -50.00')).toEqual([1150, -50]);
    expect(extractTotalCandidates('TOTAL -499.00\nRefund Total 499.00')).toEqual([-499, 499]);
    expect(extractAmounts('Sub Total 1000.00\nVAT 150.00\nTotal 1150.00\nBalance Due 0.00').totalAmount).toBe(1150);
  });

  it('keeps a credit note negative', () => {
    expect(extractTotalCandidates('Total -115.00\nAmount Due 0.00')).toEqual([-115]);
  });

  it('does not read a prefixed Balance as the payable', () => {
    expect(extractAmounts('TOTAL 23.00\nCARD 23.00\nSmart Shopper Balance 45.00').totalAmount).toBe(23);
  });

  it('validateReceiptExtraction refuses a total of zero or less', () => {
    const base = { date: '2026-09-01', vendorName: 'Spar', vatAmount: 0 } as ExtractedDocument;
    expect(validateReceiptExtraction({ ...base, totalAmount: 0 }).errors).toContain('totalAmount must be positive');
    expect(validateReceiptExtraction({ ...base, totalAmount: -115 }).valid).toBe(false);
    expect(validateReceiptExtraction({ ...base, totalAmount: 23 }).valid).toBe(true);
  });
});
