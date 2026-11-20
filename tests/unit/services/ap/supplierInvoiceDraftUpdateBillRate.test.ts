/**
 * update_supplier_invoice: whether the bill's VAT rate was NAMED by a caller decides whether a line with an item and no rate
 * takes the item's VAT (src: ap/supplierInvoiceDraftUpdate.ts `billRateWasNamed`). A bill written with `tax_rate: 0` (a
 * supplier that is not a VAT vendor) must not gain a 15% input-VAT claim from an edit that sends no rate.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { billRateWasNamed } from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';
import { DEFAULT_SUPPLIER_TAX_RATE } from '@/modules/accounting/constants/supplierInvoiceDefaults';

describe('billRateWasNamed', () => {
  it('a rate in the edit is a named rate, whatever is stored', () => {
    expect(billRateWasNamed(0, DEFAULT_SUPPLIER_TAX_RATE)).toBe(true);
    expect(billRateWasNamed(DEFAULT_SUPPLIER_TAX_RATE, DEFAULT_SUPPLIER_TAX_RATE)).toBe(true);
  });

  it('with no rate in the edit, a stored rate other than the default was named when the bill was written', () => {
    expect(billRateWasNamed(undefined, 0)).toBe(true);
    expect(billRateWasNamed(undefined, 14)).toBe(true);
  });

  it('with no rate in the edit and the default stored, nobody named one: the item\'s VAT applies', () => {
    expect(billRateWasNamed(undefined, DEFAULT_SUPPLIER_TAX_RATE)).toBe(false);
  });
});
