/**
 * K-076 — a printed minus sign is read, and a negative total never auto-posts.
 *
 * `AMOUNT` carried no sign, and both the label separator (`[:-]?`) and the
 * word separator `SEP` (`[\s._/-]*`) ate a hyphen unconditionally. Measured on
 * the previous commit, `CREDIT NOTE / Sub Total -100.00 / VAT 15% -15.00 /
 * Total -115.00` came back `{subtotal: 100, vatAmount: 15, totalAmount: 115}`
 * with `warnings: []` and `autoPost: true` — a refund read as a purchase, the
 * direction of the posting reversed, unattended. `detectDocumentType` answers
 * `credit_note` on the same text, so the sign was the only thing lost and
 * nothing downstream consults the document type.
 *
 * Both directions are asserted here, because the separator is the ambiguity:
 * a dash printed AS a separator must still not become a minus sign.
 */

import { describe, expect, it } from 'vitest';
import { extractAmounts, detectDocumentType } from '@/modules/accounting/services/core/ocrExtractionService';
import { shouldAutoPostReceipt } from '@/modules/accounting/services/bank/receiptToJournalService';

const AUTO_POST = { maxAmount: 5000, minConfidence: 0.85 };

function read(text: string) {
  const amounts = extractAmounts(text);
  return {
    ...amounts,
    autoPost: shouldAutoPostReceipt(amounts.totalAmount ?? 0, 0.95, AUTO_POST, amounts.warnings),
  };
}

describe('K-076 — the sign of a printed amount', () => {
  it('reads a credit note negative, and refuses to post it unattended', () => {
    const note = 'CREDIT NOTE\nSub Total -100.00\nVAT 15% -15.00\nTotal -115.00';
    expect(detectDocumentType(note)).toBe('credit_note');
    const result = read(note);
    expect(result).toMatchObject({ subtotal: -100, vatAmount: -15, totalAmount: -115 });
    // A refund is a real accounting event and not this route's: nobody is
    // looking on the unattended path, and the journal it would build is a
    // REVERSED expense entry that balances by construction.
    expect(result.autoPost).toBe(false);
  });

  it('reads a VAT line printed without cents on a credit note', () => {
    // `isPlausibleVatAmount` compares MAGNITUDE. While it compared signed
    // values, `-15 <= -115` was false and the tax line was refused as a
    // registration number, so the whole figure was lost.
    const result = read('CREDIT NOTE\nSub Total -100.00\nVAT -15\nTotal -115.00');
    expect(result.vatAmount).toBe(-15);
  });

  // The other direction: a dash is a separator far more often than a sign.
  const DASH_AS_SEPARATOR = [
    'Sub Total - 1000.00\nVAT - 150.00\nTotal Due - 1150.00',
    'Sub Total -  1000.00\nVAT -  150.00\nTotal Due -  1150.00',
    'Sub-Total: 1000.00\nVAT: 150.00\nTotal Due: 1150.00',
  ];

  it.each(DASH_AS_SEPARATOR)('keeps a spaced dash a separator, not a minus sign', (text) => {
    const result = read(text);
    expect(result).toMatchObject({ subtotal: 1000, vatAmount: 150, totalAmount: 1150 });
    expect(result.warnings).toEqual([]);
    expect(result.autoPost).toBe(true);
  });

  it('still refuses a zero total unattended', () => {
    expect(shouldAutoPostReceipt(0, 0.99, AUTO_POST, [])).toBe(false);
    expect(shouldAutoPostReceipt(1150, 0.99, AUTO_POST, [])).toBe(true);
  });
});
