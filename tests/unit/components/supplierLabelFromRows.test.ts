import { describe, it, expect } from 'vitest';
import { supplierLabelFromRows } from '@/components/accounting/supplier-invoices/supplierLabelFromRows';

const A = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const B = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

describe('supplierLabelFromRows', () => {
  it('names the filtered supplier from its own rows', () => {
    expect(supplierLabelFromRows([{ supplierId: A, supplierName: 'Acme' }], A, '')).toBe('Acme');
  });

  it("never names a new selection from the previous supplier's rows", () => {
    expect(supplierLabelFromRows([{ supplierId: B, supplierName: 'Bravo' }], A, '')).toBeNull();
  });

  it('corrects a label that disagrees with the rows', () => {
    expect(supplierLabelFromRows([{ supplierId: A, supplierName: 'Acme' }], A, 'Someone Else')).toBe('Acme');
  });

  it('does nothing when the label is already right, with no filter, or no rows', () => {
    expect(supplierLabelFromRows([{ supplierId: A, supplierName: 'Acme' }], A, 'Acme')).toBeNull();
    expect(supplierLabelFromRows([{ supplierId: A, supplierName: 'Acme' }], '', '')).toBeNull();
    expect(supplierLabelFromRows([], A, '')).toBeNull();
  });
});
