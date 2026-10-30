// An open invoice whose client_id points at no customer row is listed in the AR aging under
// "Unknown customer" (ar/arAgingInvoices LEFT JOIN). Drilling into that row must work, not
// answer "Client not found"; an id with no customer AND no open invoice is still not found.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/shared/agingRewind', () => ({
  rewindAmount: vi.fn(() => 'REWIND'),
  effectivePaidExpr: vi.fn(() => 'PAID'),
}));
vi.mock('@/modules/accounting/services/shared/softDeleteLedgerPresence', () => ({
  documentInLedgerAsAtFragment: vi.fn(() => 'LEDGER'),
}));
vi.mock('@/modules/accounting/services/ar/disputeService', () => ({
  getOpenDisputeTotals: vi.fn(async () => new Map<string, number>()),
}));

import { sql } from '@/lib/neon';
import { getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';

const COMPANY = '11111111-1111-4111-9111-111111111111';
const ORPHAN = '33333333-3333-4333-9333-333333333333';
const row = {
  id: 'i1', entity_id: ORPHAN, entity_name: 'Unknown customer', due_date: '2026-05-01', due_date_missing: false,
  invoice_number: 'INV-9', invoice_date: '2026-04-01', reference: null, total_amount: '100.00', amount_paid: '0', balance: '100.00',
};

beforeEach(() => { vi.mocked(sql).mockReset(); });

describe('AR aging detail for a customer-less invoice', () => {
  it('returns its invoices under "Unknown customer"', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never) // no customers row
      .mockResolvedValueOnce([row] as never);
    const detail = await getARAgingDetail(COMPANY, ORPHAN, '2026-06-30');
    expect(detail.client).toEqual({ id: ORPHAN, name: 'Unknown customer' });
    expect(detail.invoices.map((i) => [i.id, i.balance])).toEqual([['i1', 100]]);
    expect(detail.buckets?.total).toBe(100);
  });

  it('an id with no customer and no open invoice is still not found', async () => {
    vi.mocked(sql).mockResolvedValue([] as never);
    await expect(getARAgingDetail(COMPANY, ORPHAN, '2026-06-30')).rejects.toThrow(`Client ${ORPHAN} not found`);
  });
});
