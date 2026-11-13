/**
 * planMirroredSupplierNote serialises mirrored creates per bill: it takes the bill's credit-note key
 * (the key approveCreditNote takes after its note row) BEFORE it reads the bill's VAT and its open drafts,
 * so a second create waits for the first to commit and then sees its draft. Proven against a real
 * database in tests/integration/credit-note-mirror-bill-drafts.int.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const order: string[] = [];
vi.mock('@/modules/accounting/services/ar/creditNotePostingChecks', () => ({
  lockInvoiceCreditNotes: vi.fn(async (id: string) => { order.push(`lock:${id}`); }),
}));
vi.mock('@/modules/accounting/services/reports/documentVatHistory', () => ({
  getDocumentVatHistory: vi.fn(async () => {
    order.push('history');
    return {
      document_number: 'SIV1', document_status: 'approved', lines: [],
      totals: { vat_posted: 150, vat_net_now: 150, vat_derivable_now: 150, vat_heuristic: 0, net_base_posted: 1000, net_base_now: 1000 },
      heuristic: { searched: true, truncated: false, limit: 100 },
    };
  }),
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => { order.push('drafts'); return [{ id: 'd1', credit_note_number: 'CN-1', subtotal: '400.00', tax_amount: '60.00' }]; }),
}));

import { sql } from '@/lib/neon';
import { NO_ACK, planMirroredSupplierNote } from '@/modules/accounting/services/ap/supplierCreditNoteMirror';

describe('planMirroredSupplierNote', () => {
  it('locks the bill first, then reads its VAT and its open drafts (company-scoped), and nets the drafts off', async () => {
    const r = await planMirroredSupplierNote('co-1', 'bill-1', 600, NO_ACK);
    expect(order).toEqual(['lock:bill-1', 'history', 'drafts']);
    const q = (vi.mocked(sql).mock.calls[0]![0] as unknown as string[]).join('?');
    expect(q).toMatch(/cn\.company_id = \?::UUID/);
    expect(q).toMatch(/cn\.status = 'draft'/);
    expect(vi.mocked(sql).mock.calls[0]).toContain('co-1');
    expect(r).toMatchObject({ ok: true, plan: { taxAmount: 90, netBaseNow: 600, vatNetNow: 90 } });
  });
});
