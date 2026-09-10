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
 * twice; the reader now collects every candidate and picks the one the
 * document's own arithmetic endorses, or the BOTTOM one with the disagreement
 * declared so `shouldAutoPostReceipt` refuses.
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
    autoPost: shouldAutoPostReceipt(amounts.totalAmount ?? 0, 0.95, AUTO_POST, amounts.warnings),
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

  it('lets the document arithmetic pick the payable when a net is printed', () => {
    // `Delivery Total` is a candidate and `Sub Total` is not; 1000 + 150 picks
    // 1150 out of the pair on evidence, so this posts unattended as before.
    const result = read('Delivery Total 250.00\nSub Total 1000.00\nVAT 150.00\nTotal Due 1150.00');
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
    expect(result.warnings).toEqual([]);
    expect(result.autoPost).toBe(true);
  });

  it('does not warn when the document prints one total twice', () => {
    const result = read('TOTAL (VAT INCL) 1150.00\nTotal Due 1150.00');
    expect(result.totalAmount).toBe(1150);
    expect(result.warnings).toEqual([]);
  });

  it('leaves the ordinary single-total slip exactly as it was', () => {
    const result = read('Sub Total 1000.00\nVAT 150.00\nTotal Due 1150.00');
    expect(result).toMatchObject({ subtotal: 1000, vatAmount: 150, totalAmount: 1150, autoPost: true });
    expect(result.warnings).toEqual([]);
  });
});
