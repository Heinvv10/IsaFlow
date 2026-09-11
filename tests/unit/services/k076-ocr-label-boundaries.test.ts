/**
 * K-076 — the OCR total and VAT labels match anywhere in the document.
 *
 * ocrExtractionService.ts:156 begins `(?:Grand\s*)?Total` with no left word
 * boundary, so the "total" inside "Subtotal" satisfies it. `text.match`
 * returns the FIRST occurrence, and on a normal invoice "Subtotal" is printed
 * above "Total Due" — so totalAmount is silently set to the VAT-exclusive
 * figure.
 *
 * ocrExtractionService.ts:166 makes every separator optional after "VAT", so
 * a bare "VAT: <registration number>" line is read as a VAT amount. The
 * commoner "VAT Reg No:" / "VAT No:" forms do NOT match (probe: the letters
 * after the optional `R` break it), so only the bare form is affected.
 *
 * RED for the claimed reason on both counts.
 */
import { describe, expect, it } from 'vitest';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';

describe('K-076 OCR label boundaries', () => {
  it('does not read the Subtotal line as the invoice total', () => {
    const text = 'Subtotal: 1000.00\nVAT @ 15%: 150.00\nTotal Due: 1150.00';
    expect(extractAmounts(text).totalAmount).toBe(1150);
  });

  it('does not read a bare VAT registration line as a VAT amount', () => {
    const text = 'ACME Trading (Pty) Ltd\nVAT: 4123456789\nTotal 1150.00';
    expect(extractAmounts(text).vatAmount).not.toBe(4123456789);
  });
});

describe('K-076 adjacent cases', () => {
  it('reads the VAT amount past a registration number printed above it', () => {
    const text = 'ACME Trading (Pty) Ltd\nVAT: 4123456789\nVAT @ 15%: 150.00\nTotal Due: 1150.00';
    expect(extractAmounts(text).vatAmount).toBe(150);
  });

  it('still reads the currency form "VAT R 150,00"', () => {
    expect(extractAmounts('VAT R 150,00\nTotal Due R1 150,00').vatAmount).toBe(150);
  });

  it('returns no total rather than the subtotal when only a Subtotal is printed', () => {
    // The documented trade-off: a document with no total line now extracts
    // none, which computeConfidence surfaces, instead of silently reporting the
    // VAT-exclusive figure as the amount payable.
    expect(extractAmounts('Subtotal: 1000.00\nVAT @ 15%: 150.00').totalAmount).toBe(1150);
    expect(extractAmounts('Subtotal: 1000.00').totalAmount).toBeNull();
  });

  it('does not read "Total Excluding VAT" as the payable total', () => {
    const text = 'Total Excluding VAT: 1000.00\nVAT @ 15%: 150.00\nTotal Due: 1150.00';
    expect(extractAmounts(text).totalAmount).toBe(1150);
  });
});

describe('K-076 the Subtotal label in every spelling the codebase already knows', () => {
  // The first boundary was `(?:^|[^A-Za-z])`, and a space or a hyphen IS a
  // non-letter — so only the joined spelling was actually fixed. The file's own
  // subtotal patterns read `Sub\\s*[-\\s]?Total`, which is how we know both of
  // these turn up on real documents.
  it.each([
    ['Subtotal', 'Subtotal: 1000.00\nVAT @ 15%: 150.00\nTotal Due: 1150.00'],
    ['Sub Total', 'Sub Total: 1000.00\nVAT @ 15%: 150.00\nTotal Due: 1150.00'],
    ['Sub-Total', 'Sub-Total: 1000.00\nVAT @ 15%: 150.00\nTotal Due: 1150.00'],
    ['SUB TOTAL', 'SUB TOTAL 1000.00\nVAT @ 15% 150.00\nTOTAL DUE 1150.00'],
  ])('does not read a %s line as the invoice total', (_label, text) => {
    expect(extractAmounts(text).totalAmount).toBe(1150);
  });

  it('reads the SA-formatted spaced spelling as the grand total', () => {
    expect(extractAmounts('Sub Total 1 000,00\nGrand Total 1 150,00').totalAmount).toBe(1150);
  });
});

describe('K-076 the bare VAT column, and what happens when it is lost', () => {
  it('reads a VAT figure printed in a whitespace-separated column', () => {
    expect(extractAmounts('VAT      150.00\nTOTAL DUE   1150.00').vatAmount).toBe(150);
  });

  it('reads a stated VAT of ZERO as zero, not as absent', () => {
    // The one that matters. A null vatAmount makes
    // buildExpenseJournalFromReceipt derive 15% of the total, so losing this
    // line turns a zero-rated till slip into an invented R150 input-tax claim
    // — the same defect K-072 fixes, arriving through the K-076 half.
    const text = 'PICK N PAY\nBread 15.00\nMilk 20.00\nVAT 0.00\nTOTAL 1150.00';
    const result = extractAmounts(text);
    expect(result.vatAmount).toBe(0);
    expect(result.subtotal).toBe(1150);
    expect(result.totalAmount).toBe(1150);
  });

  it('does not read the RATE as the amount when the @ is not printed', () => {
    expect(extractAmounts('VAT 15% 150.00\nTotal Due 1150.00').vatAmount).not.toBe(15);
  });
});

describe('K-076 registration numbers are rejected by value, not by digit count', () => {
  // `^\\d{9,10}$` was a shape test: one OCR digit too many or too few escaped
  // it. What actually separates a registration number from a tax amount is
  // that the tax can never exceed the document total.
  it.each([
    ['9 digits', 'VAT: 412345678\nTotal 1150.00'],
    ['10 digits', 'VAT: 4123456789\nTotal 1150.00'],
    ['11 digits', 'VAT: 41234567890\nTotal 1150.00'],
    ['8 digits', 'VAT: 41234567\nTotal 1150.00'],
  ])('rejects a %s registration run', (_label, text) => {
    expect(extractAmounts(text).vatAmount).toBeNull();
  });

  it('derives no subtotal at all from a junk VAT candidate', () => {
    const result = extractAmounts('VAT: 41234567890\nTotal 1150.00');
    expect(result.subtotal).toBeNull();
  });

  it('refuses to derive a NEGATIVE subtotal when the VAT exceeds the total', () => {
    // A decimal VAT candidate passes the plausibility test on its shape, so a
    // mis-read decimal point can still put the tax above the total. total-vat
    // is then negative, and a negative subtotal is not a subtotal.
    const result = extractAmounts('VAT: 2000.00\nTotal Due: 1150.00');
    expect(result.vatAmount).toBe(2000);
    expect(result.subtotal).toBeNull();
  });

  it('keeps a whole-rand VAT amount that is smaller than the total', () => {
    expect(extractAmounts('VAT: 150\nTotal Due: 1150.00').vatAmount).toBe(150);
  });

  it('rejects a bare registration number when no total anchors the comparison', () => {
    expect(extractAmounts('VAT 4123456789').vatAmount).toBeNull();
  });
});

describe('K-076 a split VAT summary', () => {
  it('sums the VAT lines when the arithmetic proves the sum', () => {
    const text = 'Subtotal: 1000.00\nVAT @ 15%: 100.00\nVAT @ 15%: 50.00\nTotal Due: 1150.00';
    expect(extractAmounts(text).vatAmount).toBe(150);
  });

  it('keeps the first line when summing would not reconcile', () => {
    // A document printing a per-line VAT and a "Total VAT" of the same figure
    // must not be doubled — the sum has to be proved, not assumed.
    const text = 'Subtotal: 1000.00\nVAT @ 15%: 150.00\nTotal VAT @ 15%: 150.00\nTotal Due: 1150.00';
    expect(extractAmounts(text).vatAmount).toBe(150);
  });
});

describe('K-076 the subtotal guard holds for MORE THAN ONE separator character', () => {
  // Round 2 of the blind review: the guard was `(?<!Sub[-\s])`, fixed-width-one,
  // so it rejected `Sub Total` and `Sub-Total` and let through every column that
  // prints the label with two or more spaces. Every case above uses exactly one
  // separator, which is why they were green on a live defect.
  //
  // This is the worst shape of it: with no VAT line the builder derives 15% of
  // whatever it was handed, so the entry BALANCES at the subtotal — the payable
  // total is silently R150 short and the bank credit can never match the
  // statement line.
  it.each([
    ['two spaces', 'Sub  Total 1000.00\nTotal 1150.00'],
    ['three spaces, upper case', 'SUB   TOTAL   1000.00\nTOTAL   1150.00'],
    ['a tab', 'Sub\tTotal 1000.00\nTotal 1150.00'],
    ['a non-breaking space', 'Sub  Total 1000.00\nTotal 1150.00'],
    ['a hyphen and a space', 'Sub - Total 1000.00\nTotal 1150.00'],
    ['the joined spelling', 'SubTotal 1000.00\nTotal 1150.00'],
  ])('does not read a %s subtotal label as the invoice total', (_label, text) => {
    const result = extractAmounts(text);
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
  });

  it('still reads a plain Total that merely follows a subtotal line', () => {
    // The guard must not become "any Total after the word Sub": the payable
    // total is printed below the subtotal on every invoice there is.
    expect(extractAmounts('Sub  Total 1000.00\nGrand Total 1150.00').totalAmount).toBe(1150);
  });
});

describe('K-076 a non-VAT tax line must not outrank the VAT line', () => {
  it('reads the VAT, not the levy, on a hotel bill printing both', () => {
    // `Tax` ranked ABOVE the bare `VAT` column, and the first pattern yielding
    // any candidate wins — so a tourism levy beat the tax. 12.00 has a decimal
    // part, so the plausibility test waves it through, and with the subtotal
    // derived as total − 12 the entry balances and auto-posts: R138 of input
    // tax never claimed, and the VAT201 input box short by the same.
    const text = 'Room 1000.00\nTourism Levy Tax 12.00\nVAT 150.00\nTotal Due 1162.00';
    const result = extractAmounts(text);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal).toBe(1012);
    expect(result.totalAmount).toBe(1162);
  });

  it('still reads a document whose only tax label is "Tax Amount"', () => {
    expect(extractAmounts('Tax Amount: 150.00\nTotal 1150.00').vatAmount).toBe(150);
  });

  it('prefers the candidate the document\'s own arithmetic endorses', () => {
    const text = 'Subtotal 1000.00\nTax 12.00\nTax 150.00\nTotal Due 1150.00';
    expect(extractAmounts(text).vatAmount).toBe(150);
  });
});

describe('K-076 "Excluding VAT" / "Including VAT" are total labels, not VAT labels', () => {
  it.each([
    ['Excluding', 'Total Excluding VAT 1000.00\nVAT 150.00\nTotal Including VAT 1150.00'],
    ['Excl.', 'Total Excl. VAT 1000.00\nVAT 150.00\nTotal Incl. VAT 1150.00'],
    ['Excl', 'Total Excl VAT 1000.00\nVAT 150.00\nTotal Incl VAT 1150.00'],
  ])('reads the real VAT line past a %s VAT label', (_label, text) => {
    const result = extractAmounts(text);
    expect(result.subtotal).toBe(1000);
    expect(result.vatAmount).toBe(150);
    expect(result.totalAmount).toBe(1150);
    // The whole point: these three figures reconcile, so the journal balances.
    expect(result.subtotal! + result.vatAmount!).toBe(result.totalAmount);
  });
});

describe('K-076 a malformed amount fails rather than being half-read', () => {
  it.each(['Total 1150.000', 'Total 1150.005', 'Total 1150.0001'])(
    'refuses to read %s as 1150.00',
    (text) => {
      expect(extractAmounts(text).totalAmount).toBeNull();
    },
  );

  it('still reads the ordinary two-decimal and thousands forms', () => {
    expect(extractAmounts('Total 1150.00').totalAmount).toBe(1150);
    expect(extractAmounts('Total 1 150,00').totalAmount).toBe(1150);
    expect(extractAmounts('Total 1,234.56').totalAmount).toBe(1234.56);
    expect(extractAmounts('Total 1150').totalAmount).toBe(1150);
  });
});

describe('K-076 an exclusive label with no recognisable subtotal line', () => {
  // Where a subtotal IS extracted the reconciliation arithmetic can pick the
  // tax out of the candidates on its own. These layouts print the exclusive
  // figure under a label SUBTOTAL_PATTERNS does not know, so there is no
  // subtotal to reconcile against and the label guard is the only thing
  // standing between the reader and an inverted split: without it the VAT came
  // back as 1000.00 and the subtotal as 150.00 — balanced at 1150, and an
  // R1 000 input-tax claim on an R1 150 invoice.
  it.each([
    ['Amount Excluding VAT', 'Amount Excluding VAT 1000.00\nVAT 150.00\nTotal Due 1150.00'],
    ['Price Excl VAT', 'Price Excl VAT 1000.00\nVAT 150.00\nTotal Due 1150.00'],
  ])('does not read the %s figure as the VAT', (_label, text) => {
    const result = extractAmounts(text);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal).toBe(1000);
    expect(result.totalAmount).toBe(1150);
  });
});
