/**
 * Dimensions Phase 1 — postCustomerInvoiceToGL builds its revenue legs from the
 * items' CC1/CC2/BU and the customer's FNO, read on the SAME query as the
 * invoice (no extra round trip), and never puts a dimension on the AR or VAT leg.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })), postJournalEntry: vi.fn(async () => ({})),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ resolveUserUuid: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ assertNoInactiveAccountLines: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({ getPeriodStatusForDate: vi.fn(async () => 'open') }));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', () => ({ assertJournalVatPeriodOpen: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(async (role: string) => ({ id: role })),
}));

import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';

const INV = {
  id: 'inv-1', invoice_number: 'INV-9', status: 'approved', gl_journal_entry_id: null,
  invoice_date: '2026-09-30', subtotal: '1000.00', tax_amount: '150.00', total_amount: '1150.00',
};

beforeEach(() => {
  vi.clearAllMocks();
});

type Line = { glAccountId: string; credit: number; cc1Id?: string; cc2Id?: string; buId?: string };
const posted = () => (vi.mocked(createJournalEntry).mock.calls[0]![1] as { lines: Line[] }).lines;

describe('postCustomerInvoiceToGL — revenue dimensions', () => {
  it('splits revenue by item dimensions, FNO from the customer, AR and VAT untagged', async () => {
    sqlMock.mockResolvedValueOnce([{
      ...INV, customer_fno_id: 'fno-ft',
      dim_items: [
        { amount: 700, cc1_id: null, cc2_id: 'lawley', bu_id: 'act' },
        { amount: 300, cc1_id: null, cc2_id: null, bu_id: 'maint' },
      ],
    }]).mockResolvedValue([]);
    await postCustomerInvoiceToGL('co-1', 'inv-1', 'user-1');
    const sqlText = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    expect(sqlText).toMatch(/default_cc1_id::TEXT AS customer_fno_id/);
    expect(sqlText).toMatch(/json_agg[\s\S]*customer_invoice_items cii/);
    const lines = posted();
    const revenue = lines.filter((l) => l.glAccountId === 'default_revenue');
    expect(revenue).toEqual([
      expect.objectContaining({ credit: 700, cc1Id: 'fno-ft', cc2Id: 'lawley', buId: 'act' }),
      expect.objectContaining({ credit: 300, cc1Id: 'fno-ft', buId: 'maint' }),
    ]);
    for (const l of lines.filter((x) => x.glAccountId !== 'default_revenue')) {
      expect(l.cc1Id ?? l.cc2Id ?? l.buId).toBeUndefined();
    }
  });

  it('posts the single revenue line exactly as before when nothing names a dimension', async () => {
    sqlMock.mockResolvedValueOnce([{ ...INV, customer_fno_id: null, dim_items: [{ amount: 1000 }] }]).mockResolvedValue([]);
    await postCustomerInvoiceToGL('co-1', 'inv-1', 'user-1');
    expect(posted().filter((l) => l.glAccountId === 'default_revenue'))
      .toEqual([{ glAccountId: 'default_revenue', debit: 0, credit: 1000, description: 'Revenue: INV-9' }]);
  });
});
