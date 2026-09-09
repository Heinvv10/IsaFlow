/**
 * K-075 — parseAmount strips the South African decimal comma.
 *
 * ocrExtractionService.ts:147 `str.replace(/[\s,]/g, '')` removes BOTH the
 * thousands space and the decimal comma. South African invoices print
 * "R1 150,00"; the capture group at :156 grabs "1 150,00" and parseAmount
 * turns it into 115000. Every downstream consumer (receipt-to-journal,
 * capture post-expense) then posts a hundred times the real amount.
 *
 * RED for the claimed reason: expects the SA-format total to parse as
 * 1150.00, not 115000.
 */
import { describe, expect, it } from 'vitest';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';

describe('K-075 SA decimal comma', () => {
  it('parses a comma-decimal total at its real magnitude', () => {
    const text = 'VAT @ 15% R150,00\nTotal Due R1 150,00';
    expect(extractAmounts(text).totalAmount).toBe(1150);
  });

  it('parses a comma-decimal VAT amount at its real magnitude', () => {
    const text = 'VAT @ 15% R150,00\nTotal Due R1 150,00';
    expect(extractAmounts(text).vatAmount).toBe(150);
  });

  it('still parses a point-decimal total with US thousands commas', () => {
    // Guards the fix: stripping must stay correct for "1,234.56".
    expect(extractAmounts('Total Due: 1,234.56').totalAmount).toBe(1234.56);
  });
});

describe('K-075 adjacent cases', () => {
  it('reads a non-breaking-space thousands separator with a comma decimal', () => {
    // PDF text layers emit U+00A0 between the thousands and the hundreds.
    expect(extractAmounts('Total Due: R1 234,56').totalAmount).toBe(1234.56);
  });

  it('leaves a whole-rand amount with no decimal part alone', () => {
    expect(extractAmounts('Total Due: R1 150').totalAmount).toBe(1150);
  });

  it('does not invent an amount when the label carries no number', () => {
    expect(extractAmounts('Total Due: R').totalAmount).toBeNull();
  });

  it('derives the subtotal from comma-decimal total and VAT', () => {
    // The derivation runs on the PARSED numbers, so a 100x total used to make
    // the derived subtotal wrong too.
    const result = extractAmounts('VAT @ 15% R150,00\nTotal Due R1 150,00');
    expect(result.subtotal).toBe(1000);
  });
});
