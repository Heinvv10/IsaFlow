/**
 * PRD-060: FibreFlow Accounting Module
 * 3-Way Match Validation (PO ↔ GRN ↔ Invoice)
 *
 * Validates that a supplier invoice aligns with the
 * purchase order and goods receipt note.
 */

import type { ThreeWayMatchInput, ThreeWayMatchResult, InvoiceMatchStatus } from '../types/ap.types';

const DEFAULT_TOLERANCE_PERCENT = 2;

/**
 * Validate 3-way match between PO, GRN, and supplier invoice.
 *
 * Checks:
 * 1. Invoice quantity matches PO quantity
 * 2. Invoice unit price matches PO unit price (within tolerance)
 * 3. GRN received quantity matches invoice quantity
 */
export function validateThreeWayMatch(input: ThreeWayMatchInput): ThreeWayMatchResult {
  const qtyTolerance =
    input.qtyTolerancePercent ?? input.tolerancePercent ?? DEFAULT_TOLERANCE_PERCENT;
  const priceTolerance =
    input.priceTolerancePercent ?? input.tolerancePercent ?? DEFAULT_TOLERANCE_PERCENT;
  const mismatches: string[] = [];

  // Check quantity match: Invoice vs PO (within tolerance)
  const qtyDiffPercent =
    input.poQuantity > 0
      ? Math.abs(input.invoiceQuantity - input.poQuantity) / input.poQuantity * 100
      : input.invoiceQuantity > 0 ? 100 : 0;

  const quantityMatch = qtyDiffPercent <= qtyTolerance;
  if (!quantityMatch) {
    mismatches.push(
      `Invoice quantity (${input.invoiceQuantity}) differs from PO quantity (${input.poQuantity}) by ${qtyDiffPercent.toFixed(1)}%, exceeds ${qtyTolerance}% tolerance`
    );
  }

  // Check price match: Invoice vs PO (within tolerance)
  const priceDiffPercent =
    input.poUnitPrice > 0
      ? Math.abs(input.invoiceUnitPrice - input.poUnitPrice) / input.poUnitPrice * 100
      : input.invoiceUnitPrice > 0 ? 100 : 0;

  const priceMatch = priceDiffPercent <= priceTolerance;
  if (!priceMatch) {
    mismatches.push(
      `Invoice unit price (${input.invoiceUnitPrice}) differs from PO price (${input.poUnitPrice}) by ${priceDiffPercent.toFixed(1)}%, exceeds ${priceTolerance}% tolerance`
    );
  }

  // Check GRN match: GRN received vs Invoice quantity (within qty tolerance)
  const grnDiffPercent =
    input.invoiceQuantity > 0
      ? Math.abs(input.grnQuantityReceived - input.invoiceQuantity) / input.invoiceQuantity * 100
      : input.grnQuantityReceived > 0 ? 100 : 0;

  const grnMatch = grnDiffPercent <= qtyTolerance;
  if (!grnMatch) {
    mismatches.push(
      `GRN received quantity (${input.grnQuantityReceived}) differs from invoice quantity (${input.invoiceQuantity}) by ${grnDiffPercent.toFixed(1)}%, exceeds ${qtyTolerance}% tolerance`
    );
  }

  // Determine overall status
  let status: InvoiceMatchStatus;
  if (quantityMatch && priceMatch && grnMatch) {
    status = 'fully_matched';
  } else if (quantityMatch && priceMatch && !grnMatch) {
    status = 'po_matched';
  } else if (grnMatch && (!quantityMatch || !priceMatch)) {
    status = 'grn_matched';
  } else {
    status = 'unmatched';
  }

  return {
    status,
    quantityMatch,
    priceMatch,
    grnMatch,
    mismatches,
  };
}
