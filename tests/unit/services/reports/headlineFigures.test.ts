/**
 * reports/headlineFigures: one `asAt` reaches every reader, it defaults to the
 * SAST day, books a caller already read are not read again, and a failed reader
 * fails the whole call (no zero stands in for a figure that did not load).
 * The SQL itself is run against a real ledger by
 * tests/integration/kpi-one-source.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  getCashBalance: vi.fn(),
  getOpenBook: vi.fn(),
  getMtdIncome: vi.fn(),
  todayInSast: vi.fn(() => '2026-11-12'),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/saDateParser', () => ({ todayInSast: m.todayInSast }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: m.getCashBalance }));
vi.mock('@/modules/accounting/services/reports/dashboardOpenBook', () => ({ getOpenBook: m.getOpenBook }));
vi.mock('@/modules/accounting/services/reports/mtdIncome', () => ({ getMtdIncome: m.getMtdIncome }));

import { countDraftJournals, getHeadlineCounts, getHeadlineFigures } from '@/modules/accounting/services/reports/headlineFigures';

const CO = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const book = (total: number, overdue: number) => ({ buckets: [], total, overdue, overdueDisputed: 0, parties: 1 });
const COUNTS = { draft_invoices: 3, draft_bills: 4, draft_journals: 5, bills_due_7: 6, bills_overdue: 12 };

/** The values a tagged-template call was bound with. */
const bound = (call: unknown[]): unknown[] => call.slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockResolvedValue([COUNTS]);
  m.getCashBalance.mockResolvedValue({ asAt: 'x', total: -809459.04, accounts: [], deactivatedWithBalance: [], postedThrough: null });
  m.getOpenBook.mockImplementation(async (_c: string, side: string) => (side === 'ar' ? book(1500, 1000) : book(80, 80)));
  m.getMtdIncome.mockResolvedValue({ revenueMtd: 8700, profitMtd: 1200 });
});

describe('getHeadlineFigures', () => {
  it('passes the one asAt to every reader and returns the figures', async () => {
    const h = await getHeadlineFigures(CO, '2026-10-28');
    expect(m.getCashBalance).toHaveBeenCalledWith(CO, '2026-10-28');
    expect(m.getOpenBook).toHaveBeenCalledWith(CO, 'ar', '2026-10-28');
    expect(m.getOpenBook).toHaveBeenCalledWith(CO, 'ap', '2026-10-28');
    expect(m.getMtdIncome).toHaveBeenCalledWith(CO, '2026-10-28');
    expect(bound(m.sql.mock.calls[0]!)).toContain('2026-10-28');
    expect(bound(m.sql.mock.calls[0]!)).toContain(CO);
    expect(h).toEqual({
      asAt: '2026-10-28', monthStart: '2026-10-01',
      cash: -809459.04,
      receivables: { total: 1500, overdue: 1000 }, payables: { total: 80, overdue: 80 },
      revenueMtd: 8700, profitMtd: 1200,
      draftInvoices: 3, draftBills: 4, draftJournals: 5, billsDueNext7Days: 6, billsOverdue: 12,
    });
  });

  it('defaults asAt to the SAST day', async () => {
    const h = await getHeadlineFigures(CO);
    expect(m.todayInSast).toHaveBeenCalled();
    expect(h.asAt).toBe('2026-11-12');
    expect(m.getCashBalance).toHaveBeenCalledWith(CO, '2026-11-12');
  });

  it('does not re-read books the caller supplies', async () => {
    const h = await getHeadlineFigures(CO, '2026-11-12', { books: { ar: book(7, 1), ap: book(9, 2) } });
    expect(m.getOpenBook).not.toHaveBeenCalled();
    expect(h.receivables).toEqual({ total: 7, overdue: 1 });
    expect(h.payables).toEqual({ total: 9, overdue: 2 });
  });

  it.each([
    ['cash', () => m.getCashBalance.mockRejectedValue(new Error('cash down'))],
    ['open book', () => m.getOpenBook.mockRejectedValue(new Error('book down'))],
    ['month to date', () => m.getMtdIncome.mockRejectedValue(new Error('mtd down'))],
    ['counts', () => m.sql.mockRejectedValue(new Error('counts down'))],
  ])('a failed %s read rejects the whole call', async (_name, fail) => {
    fail();
    await expect(getHeadlineFigures(CO, '2026-11-12')).rejects.toThrow(/down/);
  });
});

describe('getHeadlineCounts', () => {
  it('reads every count for the company, bills dated from asAt', async () => {
    expect(await getHeadlineCounts(CO, '2026-11-12')).toEqual({
      draftInvoices: 3, draftBills: 4, draftJournals: 5, billsDueNext7Days: 6, billsOverdue: 12,
    });
    const text = (m.sql.mock.calls[0]![0] as string[]).join('?');
    // Five subselects, each scoped to the company.
    expect(bound(m.sql.mock.calls[0]!).filter((v) => v === CO)).toHaveLength(5);
    expect(text.match(/deleted_at IS NULL/g)).toHaveLength(4);
    expect(text).toMatch(/total_amount - COALESCE\(amount_paid, 0\) > 0/);
  });
});

describe('countDraftJournals', () => {
  it('binds the period end when given, and NULL (every draft) when not', async () => {
    m.sql.mockResolvedValue([{ cnt: 2 }]);
    expect(await countDraftJournals(CO, '2026-11-30')).toBe(2);
    expect(bound(m.sql.mock.calls[0]!)).toEqual([CO, '2026-11-30', '2026-11-30']);
    await countDraftJournals(CO);
    expect(bound(m.sql.mock.calls[1]!)).toEqual([CO, null, null]);
  });
});
