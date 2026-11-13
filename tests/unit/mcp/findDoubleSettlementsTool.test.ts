/**
 * find_double_settlements — the tool's own contract. The query (every settlement path, the classification rule,
 * the two reasons, tenant isolation) is pinned against a real ledger in
 * tests/integration/find-double-settlements.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ap/doubleSettlementService', () => ({
  findDoubleSettlements: vi.fn(),
  MAX_SETTLEMENTS_PER_BILL: 50,
}));

import { findDoubleSettlements } from '@/modules/accounting/services/ap/doubleSettlementService';
import { findDoubleSettlementsTool } from '@/lib/mcp/tools/findDoubleSettlements';
import { listSupplierPaymentsTool } from '@/lib/mcp/tools/listSupplierPayments';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const SUP = '5a5a5a5a-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1' } as McpToolContext;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

const BILL = {
  billId: 'b-1', billNumber: 'SIV0003760', invoiceDate: '2026-09-01', supplierId: SUP, supplierName: 'Stephan',
  total: 150, amountPaid: 150, settledTotal: 300, overSettledBy: 150, reasons: ['over_settled', 'multiple_sources'],
  settlementCount: 2,
  settlements: [
    { kind: 'contra', documentId: 'p-1', documentNumber: 'SP-2026-01861', date: '2026-09-17', amount: 150,
      accountId: 'a-1', accountCode: '1560731', accountName: 'Bank Transfer acc - ABSA Paycards', paymentMethod: 'contra' },
    { kind: 'card_line', documentId: 'p-2', documentNumber: 'SP-2026-05014', date: '2026-09-20', amount: 150,
      accountId: 'a-2', accountCode: '1610001', accountName: 'Paycard Stephan', paymentMethod: 'eft' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findDoubleSettlements).mockResolvedValue({ rows: [], total: 0 });
});

describe('find_double_settlements', () => {
  it('is a read on the AP list scope', () => {
    expect(findDoubleSettlementsTool.write).toBe(false);
    expect(findDoubleSettlementsTool.scope).toBe(listSupplierPaymentsTool.scope);
  });

  it('refuses a bad supplier id, a bad date and a reversed range before querying', async () => {
    expect((await findDoubleSettlementsTool.handler({ supplier_id: 'abc' }, ctx)).isError).toBe(true);
    expect((await findDoubleSettlementsTool.handler({ from: '2026-02-31' }, ctx)).isError).toBe(true);
    expect(text(await findDoubleSettlementsTool.handler({ from: '2026-05-01', to: '2026-04-01' }, ctx)))
      .toBe('from must not be after to');
    expect(text(await findDoubleSettlementsTool.handler({ offset: -1 }, ctx))).toMatch(/offset must be/);
    expect(findDoubleSettlements).not.toHaveBeenCalled();
  });

  it('scopes the query to the token company and passes every filter, bounded', async () => {
    await findDoubleSettlementsTool.handler({ supplier_id: SUP, from: '2026-01-01', to: '2026-12-31', limit: 5000 }, ctx);
    expect(findDoubleSettlements).toHaveBeenCalledWith(COMPANY, {
      supplierId: SUP, fromDate: '2026-01-01', toDate: '2026-12-31', limit: 200, offset: 0,
    });
    await findDoubleSettlementsTool.handler({}, ctx);
    expect(vi.mocked(findDoubleSettlements).mock.calls[1]![1]).toEqual({
      supplierId: null, fromDate: null, toDate: null, limit: 50, offset: 0,
    });
  });

  it('reports each bill with its settlements and next_offset', async () => {
    vi.mocked(findDoubleSettlements).mockResolvedValueOnce({ rows: [BILL, BILL] as never, total: 3 });
    const out = JSON.parse(text(await findDoubleSettlementsTool.handler({ limit: 2 }, ctx)));
    expect(out.total).toBe(3);
    expect(out.next_offset).toBe(2);
    expect(out.bills[0]).toMatchObject({
      bill_id: 'b-1', bill_number: 'SIV0003760', supplier_id: SUP, supplier_name: 'Stephan', total: 150,
      amount_paid: 150, settled_total: 300, over_settled_by: 150, reasons: ['over_settled', 'multiple_sources'],
    });
    expect(out.bills[0].settlements[0]).toEqual({
      kind: 'contra', document_id: 'p-1', document_number: 'SP-2026-01861', date: '2026-09-17', amount: 150,
      account_id: 'a-1', account_code: '1560731', account_name: 'Bank Transfer acc - ABSA Paycards', payment_method: 'contra',
    });
    vi.mocked(findDoubleSettlements).mockResolvedValueOnce({ rows: [BILL] as never, total: 3 });
    expect(JSON.parse(text(await findDoubleSettlementsTool.handler({ limit: 2, offset: 2 }, ctx))).next_offset).toBeNull();
  });
});
