// The per-entity aging detail returns each invoice's number, so a drill-down
// can label its rows without a second lookup.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }) }));
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
import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';

const COMPANY = '11111111-1111-4111-9111-111111111111';
const ENTITY = '22222222-2222-4222-9222-222222222222';
const row = (id: string, invoiceNumber: string) => ({
  id, entity_id: ENTITY, entity_name: 'Acme', due_date: new Date(2026, 4, 1), due_date_missing: false,
  invoice_number: invoiceNumber, total_amount: '100.00', amount_paid: '40.00', balance: '60.00',
});

beforeEach(() => { vi.mocked(sql).mockReset(); });

describe('aging detail invoice numbers', () => {
  it('AR detail carries invoice_number through as invoiceNumber', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: ENTITY, name: 'Acme' }] as never)
      .mockResolvedValueOnce([row('i1', 'INV-1'), row('i2', 'INV-2')] as never);

    const detail = await getARAgingDetail(COMPANY, ENTITY, '2026-06-30');

    expect(detail.invoices.map(i => [i.id, i.invoiceNumber, i.balance])).toEqual([['i1', 'INV-1', 60], ['i2', 'INV-2', 60]]);
  });

  it('AP detail carries invoice_number through as invoiceNumber', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: ENTITY, name: 'Acme' }] as never)
      .mockResolvedValueOnce([row('s1', 'SI-1')] as never);

    const detail = await getAPAgingDetail(COMPANY, ENTITY, '2026-06-30');

    expect(detail.invoices.map(i => [i.id, i.invoiceNumber, i.balance])).toEqual([['s1', 'SI-1', 60]]);
  });
});
