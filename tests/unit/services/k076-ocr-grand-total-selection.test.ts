/**
 * K-076 — the payable total is chosen POSITIVELY, not by a denylist.
 *
 * `TOTAL_PATTERNS` is guarded by `NOT_A_SUBTOTAL`, a lookbehind naming the net
 * labels the module knows. `String.match` returns the LEFTMOST hit, so every
 * OTHER noun a document may print in front of `Total` — a section, a course, a
 * department — was read as the amount payable. Measured on the previous
 * commit, `Food Total 200.00 / Drinks Total 50.00 / VAT 32.61 / TOTAL 287.50`
 * came back `total: 200` with NO warning and `autoPost: true`: the bank credited
 * R200.00 for an R287.50 slip, silently, because with no printed net the
 * subtotal is derived as total − VAT and the entry therefore BALANCES by
 * construction — no downstream gate can see it.
 *
 * The nouns below are deliberately ones no denylist in this repo has ever
 * contained. Adding them to a denylist is the move that produced this defect
 * twice; the reader now collects every candidate, offers the BOTTOM one as a
 * guess and declares the disagreement, and `shouldAutoPostReceipt` refuses any
 * slip that prints more than one total (`k076-unattended-posting-gate`).
 */

import { describe, expect, it } from 'vitest';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';
import { shouldAutoPostReceipt } from '@/modules/accounting/services/bank/receiptToJournalService';
import { isUnreconciled } from '@/modules/accounting/services/core/ocrAmountReconciliation';

const AUTO_POST = { maxAmount: 5000, minConfidence: 0.85 };

function read(text: string) {
  const amounts = extractAmounts(text);
  return {
    ...amounts,
    // A structured (VLM) extraction holding the reader's figures: the regex
    // fallback itself never posts unattended (K-072 round 14), so this is how
    // the gate's own arithmetic is exercised.
    autoPost: shouldAutoPostReceipt({ documentType: 'receipt', rawText: text, ...amounts, confidence: 0.95, extractionMethod: 'vlm' }, AUTO_POST),
  };
}

describe('K-076 — a section total is never the payable total', () => {
  it('reads the grand total of a multi-section till slip, not the first section', () => {
    const slip = 'Tashas Cafe\nFood Total 200.00\nDrinks Total 50.00\nVAT 32.61\nTOTAL 287.50';
    const result = read(slip);
    expect(result.totalAmount).toBe(287.5);
    // And it does not post unattended: the reader cannot prove which figure is
    // the payable, so a person reads both before the bank is credited.
    expect(isUnreconciled(result.warnings)).toBe(true);
    expect(result.autoPost).toBe(false);
  });

  // Nouns that appear in no denylist in this module — the point of the fix.
  const UNKNOWN_SECTION_LABELS = [
    'Beverage', 'Kitchen', 'Pharmacy', 'Workshop', 'Trolley',
    'Goods', 'Items', 'Line', 'Order', 'Deposit',
  ];

  it.each(UNKNOWN_SECTION_LABELS)('"%s Total" above the payable does not become the payable', (label) => {
    const result = read(`${label} Total 250.00\nVAT 150.00\nTotal Due 1150.00`);
    expect(result.totalAmount).toBe(1150);
    expect(result.autoPost).toBe(false);
  });

  it('does not let the document arithmetic pick one of several totals', () => {
    // `Delivery Total` is a candidate and `Sub Total` is not. Round 8 let
    // 1000 + 150 pick 1150 out of the pair and post it; the same rule, on the
    // VAT-analysis slip, picked the standard-rated 230.00 under a payable of
    // 253.00. Arithmetic proves a figure is A total, not THE total — so the
    // bottom figure is offered as the guess and the slip goes to a person.
    const result = read('Delivery Total 250.00\nSub Total 1000.00\nVAT 150.00\nTotal Due 1150.00');
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
    expect(isUnreconciled(result.warnings)).toBe(true);
    expect(result.autoPost).toBe(false);
  });

  // The MIRROR of the section-total defect, and the one the first version of
  // this fix inverted. `subtotal + VAT` matching a candidate ANYWHERE endorsed
  // the INTERMEDIATE total on the ordinary layout that prints an extra BELOW
  // the Sub Total / VAT / Total block, and suppressed the warning while doing
  // it: measured, total 230.00 against a payable of 253.00, `warnings: []`,
  // `autoPost: true`, and the bank credited R230.00. Only the BOTTOM figure may
  // be endorsed.
  const EXTRAS_BELOW_THE_BLOCK: [string, string, number][] = [
    ['a gratuity', 'Gratuity 23.00\nTotal Due 253.00', 253],
    ['a delivery fee', 'Delivery 57.50\nTotal Due 287.50', 287.5],
    ['a rounding line', 'Rounding 0.05\nTotal Due 230.05', 230.05],
  ];

  it.each(EXTRAS_BELOW_THE_BLOCK)('reads the payable when %s is printed below the total', (_label, tail, payable) => {
    const result = read(`Ocean Basket\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n${tail}`);
    expect(result.totalAmount).toBe(payable);
    expect(isUnreconciled(result.warnings)).toBe(true);
    expect(result.autoPost).toBe(false);
  });

  it('refuses rather than guesses when the endorsed figure is not the bottom one', () => {
    // The cost of the rule above, stated as an outcome rather than left to be
    // rediscovered: a cash-tendered line printed UNDER an endorsed payable is
    // indistinguishable from a gratuity by arithmetic, and by label only to a
    // denylist — which is what this module abolished. On an unattended posting
    // path an ambiguous document goes to a person.
    const result = read('Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00\nCash Total 1200.00');
    expect(isUnreconciled(result.warnings)).toBe(true);
    expect(result.autoPost).toBe(false);
  });

  it('does not warn when the document prints one total twice', () => {
    const result = read('TOTAL (VAT INCL) 1150.00\nTotal Due 1150.00');
    expect(result.totalAmount).toBe(1150);
    expect(result.warnings).toEqual([]);
  });

  it('collects candidates across EVERY label form, ordered by where they print', () => {
    // The loop returned on the FIRST productive pattern, so a plain `Total`
    // above the payable made `Amount Due` unreachable — one candidate, no
    // warning, R230.00 posted against a payable of R253.00. Both figures are
    // candidates now, and the guess offered to the reviewer is the BOTTOM one,
    // which is what the ordering by match position buys.
    const below = read('Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\nGratuity 23.00\nAmount Due 253.00');
    expect(below.totalAmount).toBe(253);
    expect(isUnreconciled(below.warnings)).toBe(true);
    expect(below.autoPost).toBe(false);

    // The same two labels the other way up: the guess follows the DOCUMENT'S
    // order, not the pattern list's.
    const above = read('AMOUNT DUE 253.00\nCASH 300.00\nVAT ANALYSIS\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00');
    expect(above.totalAmount).toBe(230);
    expect(above.autoPost).toBe(false);
  });

  it('leaves the ordinary single-total slip exactly as it was', () => {
    const result = read('Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00');
    expect(result).toMatchObject({ subtotal: 1000, vatAmount: 150, totalAmount: 1150, autoPost: true });
    expect(result.warnings).toEqual([]);
  });
});
