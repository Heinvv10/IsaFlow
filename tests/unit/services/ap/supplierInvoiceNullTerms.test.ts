/**
 * supplier_invoices.payment_terms is NULL where it used to be 'net30' (the new-bill page now sends terms only when the
 * user picked them). Every reader maps a NULL to "no terms" (undefined / null / a dash), never the text "null".
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { mapInvoiceRow as mapQuery } from '@/modules/accounting/services/ap/supplierInvoiceMapper';
import { mapInvoiceRow as mapWorkflow } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowRow';

const ROW = {
  id: 'i', invoice_number: 'N', supplier_id: 's', invoice_date: '2026-09-16', due_date: null, subtotal: '1', tax_rate: '15', tax_amount: '0',
  total_amount: '1', amount_paid: '0', balance: '1', payment_terms: null, currency: 'ZAR', status: 'draft', match_status: 'unmatched',
  created_at: '2026-09-16', updated_at: '2026-09-16',
};

describe('a bill with NULL payment_terms', () => {
  it.each([['supplierInvoiceMapper', mapQuery], ['supplierInvoiceWorkflowRow', mapWorkflow]])('%s maps it to undefined', (_n, map) => {
    expect(map(ROW as never).paymentTerms).toBeUndefined();
  });
  it('a bill with terms keeps them', () => {
    expect(mapQuery({ ...ROW, payment_terms: 'net30' } as never).paymentTerms).toBe('net30');
  });
});
