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
    autoPost: shouldAutoPostReceipt({ documentType: 'receipt', rawText: text, ...amounts, confidence: 0.95 }, AUTO_POST),
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
    expect(read('Sub Total 0.00\nVAT 0.00\nTotal 0.00').autoPost).toBe(false);
    expect(read('Sub Total 1150.00\nVAT 0.00\nTotal 1150.00').autoPost).toBe(true);
  });

  // The VAT line's separator is REQUIRED. Round 9 stopped it consuming a dash
  // glued to the figure, which did not make `VAT-0.00` negative — it made it
  // NULL, and the builder replaces a null VAT with 15% of the total: an
  // invented R13.04 claim on a zero-rated slip, auto-posted.
  it('reads VAT-0.00 as a zero, not as nothing', () => {
    expect(read('Sub Total 100.00\nVAT-0.00\nTotal 100.00').vatAmount).toBe(0);
    expect(read('VAT-0.00\nTotal 100.00').vatAmount).toBe(0);
  });

  it('reads VAT-150.00 with its sign, and refuses it', () => {
    const result = read('Sub Total 1000.00\nVAT-150.00\nTotal Due 1150.00');
    expect(result.vatAmount).toBe(-150);
    expect(result.autoPost).toBe(false);
  });

  it('still refuses a registration number glued to a dash as the VAT', () => {
    // The glued dash is now read as a SIGN here, so `-4123456789` reaches the
    // plausibility test — which compares magnitude, and refuses it.
    const result = read('VAT-4123456789\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00');
    expect(result.vatAmount).toBe(150);
  });

  // `VALUE_SEP` at every label it sits behind: a dash glued to the figure is a
  // minus sign. Each row fails if its site reverts to consuming the dash.
  const GLUED_MINUS: [string, string, Partial<Record<'subtotal' | 'vatAmount' | 'totalAmount', number>>][] = [
    ['Amount Due', 'Amount Due -115.00', { totalAmount: -115 }],
    ['Incl VAT', 'Incl VAT -115.00', { totalAmount: -115 }],
    ['Tax Amount', 'Sub Total -100.00\nTax Amount -15.00', { vatAmount: -15 }],
    ['Excl VAT', 'Excl VAT -100.00', { subtotal: -100 }],
    ['Nett Excl', 'Nett Excl -100.00', { subtotal: -100 }],
  ];

  it.each(GLUED_MINUS)('reads a minus sign glued to the figure after "%s"', (_label, text, expected) => {
    expect(extractAmounts(text)).toMatchObject(expected);
  });
});
