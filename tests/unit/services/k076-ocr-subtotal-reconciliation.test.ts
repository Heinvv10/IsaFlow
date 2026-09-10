/**
 * K-076 — a PRINTED subtotal the document's own total and tax contradict.
 *
 * An invoice that prints a subtotal and then a levy, a service charge or a
 * delivery fee before the total has `subtotal + VAT != total` while every
 * figure on it has been read correctly. The callers' balance pre-check then
 * refuses a well-formed document with a flat 400, and the operator is told the
 * receipt "does not balance" with no indication of which figure to look at.
 *
 * The reader now prefers the derived net where the split looks standard-rated,
 * and says so. It does NOT prefer it unconditionally: a mis-read tax line fails
 * to reconcile in exactly the same way, and rebasing the split on it would post
 * a wrong claim instead of refusing — the two cases are told apart by whether
 * the derived split is consistent with 15%.
 */
import { describe, expect, it } from 'vitest';
import { extractAmounts, extractLineItems } from '@/modules/accounting/services/core/ocrExtractionService';
import { shouldAutoPostReceipt } from '@/modules/accounting/services/bank/receiptToJournalService';

describe('K-076 a levy printed below an explicit subtotal', () => {
  const TEXT = 'Sub Total 1000.00\nTourism Levy Tax 12.00\nVAT 150.00\nTotal 1162.00';

  it('reads a net that foots against the printed total and tax', () => {
    const result = extractAmounts(TEXT);
    expect(result.totalAmount).toBe(1162);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal).toBe(1012);
    expect(result.subtotal! + result.vatAmount!).toBe(result.totalAmount);
  });

  it('says why the printed subtotal was not used', () => {
    const [warning] = extractAmounts(TEXT).warnings;
    expect(warning).toContain('1000.00');
    expect(warning).toContain('1012.00');
  });
});

describe('K-076 a tax figure the derived split does not support is still refused', () => {
  // The mirror case, and the reason the swap is conditional. R12 of VAT on an
  // R1 150 document is 1.1% of the derived net — not a standard-rated
  // document, so the printed figures stand and the caller's pre-check refuses,
  // which is what must happen rather than a silently rebased claim.
  const TEXT = 'Sub Total 1000.00\nTax 12.00\nTotal Due 1150.00';

  it('keeps the printed subtotal', () => {
    const result = extractAmounts(TEXT);
    expect(result.subtotal).toBe(1000);
    expect(result.vatAmount).toBe(12);
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal! + result.vatAmount!).not.toBe(result.totalAmount);
  });

  it('names the discrepancy instead of implying it', () => {
    expect(extractAmounts(TEXT).warnings[0]).toContain('do not reconcile');
  });
});

describe('K-076 a document that already reconciles is left alone', () => {
  it.each([
    ['a printed subtotal', 'Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00'],
    ['a derived subtotal', 'VAT 150.00\nTotal Due 1150.00'],
    ['a zero-rated slip', 'Brown Bread 1000.00\nVAT 0.00\nTotal Due 1000.00'],
  ])('%s carries no warning', (_name, text) => {
    const result = extractAmounts(text);
    expect(result.warnings).toEqual([]);
    expect(result.subtotal! + result.vatAmount!).toBe(result.totalAmount);
  });
});

describe('K-076 a summary line stops the line items, in every net spelling', () => {
  // The terminator used to be a second, hand-spelled copy of the subtotal
  // grammar that knew only `Sub[\s-]*Total`, so a `Nett Total` summary line was
  // collected as an expense line item.
  it.each([
    ['Sub Total', 'Sub Total     1000.00'],
    ['Nett Total', 'Nett Total     1000.00'],
    ['Net Total', 'Net Total     1000.00'],
    ['S/Total', 'S/Total     1000.00'],
    ['Goods Value', 'Goods Value     1000.00'],
    ['Total Excl VAT', 'Total Excl VAT     1000.00'],
    // The last place the terminator was narrower than the pattern it mirrors:
    // SUBTOTAL_PATTERNS reads `Amount Excl VAT` as the net, while this list
    // stopped at the bare `Excl VAT` — so the summary line was ALSO collected
    // as an R1 000 expense line item.
    ['Amount Excl VAT', 'Amount Excl VAT     1000.00'],
    ['Price Ex VAT', 'Price Ex VAT     1000.00'],
    ['Sub Total Excl VAT', 'Sub Total Excl VAT     1000.00'],
    ['V.A.T.', 'V.A.T.     150.00'],
    ['Output Tax', 'Output Tax     150.00'],
    ['Payable', 'Payable     1150.00'],
    ['Invoice Total', 'Invoice Total     1150.00'],
  ])('%s ends item collection', (_name, summary) => {
    // Printed in a COLUMN, which is what makes this observable: a summary line
    // with a two-space gap satisfies `simpleLinePattern`, so a terminator that
    // does not recognise the label collects the summary figure as an expense
    // line item.
    const items = extractLineItems([
      'Description   Qty   Price   Amount',
      'Widget          2   50.00   100.00',
      summary,
      'Total Due     1150.00',
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe('Widget');
  });
});

describe('K-076 a document the reader could not settle does not post unattended', () => {
  // The printed subtotal is the ONLY checksum on three independently-extracted
  // figures. Inside the 13-17% band the reader now rebases the net rather than
  // leaving the callers to refuse — right for a levy printed below the
  // subtotal, and the same band admits a total mis-read by a percent or two.
  // `shouldAutoPostReceipt` reads neither the warnings nor how the confidence
  // was computed (it counts FIELDS FOUND, not whether they agree), so the
  // rebased document would have posted unattended where it used to stop.
  const config = { maxAmount: 5000, minConfidence: 0.85 };

  it('refuses auto-post when the amounts were rebased', () => {
    // 1150 mis-read as 1160: 150/1010 = 14.9%, inside the band, so the printed
    // 1000 is overwritten with 1010 and the entry balances at the wrong total.
    const result = extractAmounts('Sub Total 1000.00\nVAT 150.00\nTotal Due 1160.00');
    expect(result.subtotal).toBe(1010);
    expect(result.warnings).toHaveLength(1);
    expect(shouldAutoPostReceipt(1160, 0.95, config, result.warnings)).toBe(false);
  });

  it('refuses auto-post when the amounts were merely named as not reconciling', () => {
    const result = extractAmounts('Sub Total 1000.00\nTax 12.00\nTotal Due 1150.00');
    expect(shouldAutoPostReceipt(1150, 0.95, config, result.warnings)).toBe(false);
  });

  it('still auto-posts a document that reconciles', () => {
    const result = extractAmounts('Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00');
    expect(result.warnings).toEqual([]);
    expect(shouldAutoPostReceipt(1150, 0.95, config, result.warnings)).toBe(true);
  });

  it('leaves an unrelated warning alone', () => {
    // Only the reconciliation warnings gate the unattended path — a missing
    // merchant name is a different fact and has never blocked auto-post.
    expect(shouldAutoPostReceipt(1150, 0.95, config, ['Merchant name not extracted'])).toBe(true);
    expect(shouldAutoPostReceipt(1150, 0.95, config, [])).toBe(true);
    expect(shouldAutoPostReceipt(1150, 0.95, config)).toBe(true);
  });

  it('keeps refusing on amount and confidence', () => {
    expect(shouldAutoPostReceipt(6000, 0.95, config, [])).toBe(false);
    expect(shouldAutoPostReceipt(1150, 0.5, config, [])).toBe(false);
  });
});
