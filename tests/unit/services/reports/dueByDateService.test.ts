/**
 * The service must read the aging's own queries at TODAY (SAST), refuse a past
 * by_date before any query runs, and compute net position as AR less AP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ap/apAgingInvoices', () => ({ fetchAPAgingInvoices: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/arAgingInvoices', () => ({ fetchARAgingInvoices: vi.fn() }));

import { fetchAPAgingInvoices } from '@/modules/accounting/services/ap/apAgingInvoices';
import { fetchARAgingInvoices } from '@/modules/accounting/services/ar/arAgingInvoices';
import { DueByDateInputError, getDueByDate, getDueByDateReport } from '@/modules/accounting/services/reports/dueByDateService';
import type { OpenAgingInvoice } from '@/modules/accounting/utils/aging';

const CO = '11111111-1111-4111-8111-111111111111';

const row = (over: Partial<OpenAgingInvoice>): OpenAgingInvoice => ({
  id: 'i', invoiceNumber: 'INV-1', entityId: 'e', entityName: 'E', dueDate: '2026-11-10', dueDateMissing: false,
  totalAmount: 100, amountPaid: 0, balance: 100, invoiceDate: '2026-10-01', reference: null, ...over,
});

beforeEach(() => {
  // 23:30 UTC on the 4th is 01:30 SAST on the 5th: the app day is the 5th.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T23:30:00Z'));
  vi.mocked(fetchAPAgingInvoices).mockReset().mockResolvedValue([row({ balance: 40, entityId: 's' })]);
  vi.mocked(fetchARAgingInvoices).mockReset().mockResolvedValue([row({ balance: 100 })]);
});
afterEach(() => vi.useRealTimers());

describe('getDueByDate', () => {
  it('reads the open book as at the SAST day, both for the as-at and the rewind window', async () => {
    const r = await getDueByDate(CO, 'ar', '2026-11-30');
    expect(fetchARAgingInvoices).toHaveBeenCalledWith(CO, '2026-11-05', '2026-11-05');
    expect(r.today).toBe('2026-11-05');
    expect(r.totals.dueTodayToDate).toBe(100);
  });

  it('uses the AP query for ap and not the AR one', async () => {
    await getDueByDate(CO, 'ap', '2026-11-30');
    expect(fetchAPAgingInvoices).toHaveBeenCalledWith(CO, '2026-11-05', '2026-11-05');
    expect(fetchARAgingInvoices).not.toHaveBeenCalled();
  });

  it('accepts the SAST day itself as by_date (not the UTC day)', async () => {
    await expect(getDueByDate(CO, 'ar', '2026-11-05')).resolves.toBeDefined();
  });

  it('refuses a by_date before the SAST day without querying', async () => {
    await expect(getDueByDate(CO, 'ar', '2026-11-04')).rejects.toBeInstanceOf(DueByDateInputError);
    expect(fetchARAgingInvoices).not.toHaveBeenCalled();
  });

  it('refuses junk', async () => {
    await expect(getDueByDate(CO, 'ap', 'next friday')).rejects.toBeInstanceOf(DueByDateInputError);
  });
});

describe('getDueByDateReport', () => {
  it('nets AR less AP on total by date', async () => {
    const r = await getDueByDateReport(CO, '2026-11-30');
    expect(r.ar.totals.totalByDate).toBe(100);
    expect(r.ap.totals.totalByDate).toBe(40);
    expect(r.netPosition).toBe(60);
  });

  it('goes negative when payables exceed receivables', async () => {
    vi.mocked(fetchARAgingInvoices).mockResolvedValue([row({ balance: 10 })]);
    const r = await getDueByDateReport(CO, '2026-11-30');
    expect(r.netPosition).toBe(-30);
  });
});
