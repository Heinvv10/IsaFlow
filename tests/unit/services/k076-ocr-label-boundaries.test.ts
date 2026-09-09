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
