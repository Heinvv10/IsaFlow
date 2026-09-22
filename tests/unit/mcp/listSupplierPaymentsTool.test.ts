/**
 * list_supplier_payments — the tool's own contract. The query (filters,
 * applied/unapplied figures, a walk that serves every payment once, tenant
 * isolation) is pinned against a real ledger in
 * tests/integration/list-supplier-payments.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ap/supplierPaymentListService', () => ({
  listSupplierPayments: vi.fn(),
}));

import { listSupplierPayments } from '@/modules/accounting/services/ap/supplierPaymentListService';
import { listSupplierPaymentsTool } from '@/lib/mcp/tools/listSupplierPayments';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const SUP = '5a5a5a5a-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1' } as McpToolContext;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const empty = { rows: [], total: 0, totals: { paymentAmount: 0, allocatedAmount: 0, unappliedAmount: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSupplierPayments).mockResolvedValue(empty);
});

describe('list_supplier_payments', () => {
  it('refuses a status outside the enum — the schema enum is documentation only', async () => {
    const r = await listSupplierPaymentsTool.handler({ status: 'paid' }, ctx);
    expect(text(r)).toBe('status must be one of: draft, approved, processed, reconciled, cancelled');
    expect(listSupplierPayments).not.toHaveBeenCalled();
  });

  it('refuses a reversed date range, a bad date and a bad supplier id before querying', async () => {
    expect(text(await listSupplierPaymentsTool.handler({ from_date: '2026-05-01', to_date: '2026-04-01' }, ctx)))
      .toBe('from_date must not be after to_date');
    expect((await listSupplierPaymentsTool.handler({ from_date: '2026-02-31' }, ctx)).isError).toBe(true);
    expect((await listSupplierPaymentsTool.handler({ supplier_id: 'abc' }, ctx)).isError).toBe(true);
    expect(listSupplierPayments).not.toHaveBeenCalled();
  });

  it('passes every filter through, with the default page', async () => {
    await listSupplierPaymentsTool.handler({
      supplier_id: SUP, status: 'processed', from_date: '2026-01-01', to_date: '2026-06-30', search: 'EFT',
    }, ctx);
    expect(listSupplierPayments).toHaveBeenCalledWith(COMPANY, {
      supplierId: SUP, status: 'processed', fromDate: '2026-01-01', toDate: '2026-06-30',
      search: 'EFT', limit: 50, offset: 0,
    });
  });

  it('answers next_offset from the total, null on the last page', async () => {
    const row = {
      paymentId: 'p', paymentNumber: 'PAY-1', paymentDate: '2026-03-01', supplierId: SUP, supplierName: 'S',
      paymentAmount: 10, allocatedAmount: 4, unappliedAmount: 6, status: 'processed', paymentMethod: null,
      reference: null, description: null, journalEntryId: null, batchId: null,
    };
    vi.mocked(listSupplierPayments).mockResolvedValueOnce({ ...empty, rows: [row, row], total: 5 });
    const first = JSON.parse(text(await listSupplierPaymentsTool.handler({ limit: 2, offset: 0 }, ctx)));
    expect(first.next_offset).toBe(2);
    expect(first.payments[0]).toMatchObject({ allocated_amount: 4, unapplied_amount: 6 });

    vi.mocked(listSupplierPayments).mockResolvedValueOnce({ ...empty, rows: [row], total: 5 });
    const last = JSON.parse(text(await listSupplierPaymentsTool.handler({ limit: 2, offset: 4 }, ctx)));
    expect(last.next_offset).toBeNull();
  });
});
