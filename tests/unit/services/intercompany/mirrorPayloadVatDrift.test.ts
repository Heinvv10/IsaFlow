// Drop into tests/unit/services/intercompany/. FAILS on head 3292d0e368: legit 12-line invoice is unacceptable to its receiver.
import { describe, it, expect } from 'vitest';
import { parseMirrorPayload } from '@/modules/accounting/services/intercompany/mirrorPayload';
import { buildInvoicePayload } from '../../../helpers/mirrorReference';

describe('P2 VAT drift: header VAT = ROUND(sum x 15%) (invoiceTotals) but payload lines are rounded one by one', () => {
  it('12 lines of R10.10 mirror and parse', () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ description: `L${i}`, quantity: 1, unitPrice: 10.1, amount: 10.1, taxRate: 15 }));
    // sender: subtotal 121.20, tax ROUND(18.18)=18.18, total 139.38
    const p = buildInvoicePayload({ number: 'INV-1', date: '2026-11-20', dueDate: null, currency: 'ZAR', subtotal: 121.2, taxAmount: 18.18,
      total: 139.38, notes: null, sender: { name: 'A', vatNumber: null }, lines, pdf: null });
    const r = parseMirrorPayload(JSON.parse(JSON.stringify(p)), 'invoice', '00000000-0000-0000-0000-000000000001');
    expect(r.ok).toBe(true); // actual: { ok:false, error:'The line VAT does not add up to the document VAT' } (per-line 1.52 x 12 = 18.24, residual -6c > 5c cap)
  });
});
