/**
 * The service must read the aging's own queries at TODAY (SAST), refuse a past
 * by_date before any query runs, and compute net position as AR less AP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
const logSpy = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logSpy }));
vi.mock('@/modules/accounting/services/ap/apAgingInvoices', () => ({ fetchAPAgingInvoices: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/arAgingInvoices', () => ({ fetchARAgingInvoices: vi.fn() }));

import { fetchAPAgingInvoices } from '@/modules/accounting/services/ap/apAgingInvoices';
import { fetchARAgingInvoices } from '@/modules/accounting/services/ar/arAgingInvoices';
import { DueByDateInputError, getDueByDate, getDueByDateContact, getDueByDateReport } from '@/modules/accounting/services/reports/dueByDateService';
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
    expect(fetchARAgingInvoices).toHaveBeenCalledWith(CO, '2026-11-05', '2026-11-05', null);
    expect(r.today).toBe('2026-11-05');
    expect(r.totals.dueTodayToDate).toBe(100);
  });

  it('uses the AP query for ap and not the AR one', async () => {
    await getDueByDate(CO, 'ap', '2026-11-30');
    expect(fetchAPAgingInvoices).toHaveBeenCalledWith(CO, '2026-11-05', '2026-11-05', null);
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

describe('getDueByDateContact', () => {
  const CONTACT = 'eeeeeeee-0000-4000-8000-000000000001';

  beforeEach(() => {
    vi.mocked(fetchARAgingInvoices).mockResolvedValue([row({ entityId: CONTACT })]);
    vi.mocked(fetchAPAgingInvoices).mockResolvedValue([row({ entityId: CONTACT, balance: 40 })]);
  });

  it('finds one contact with its invoices', async () => {
    const c = await getDueByDateContact(CO, 'ar', '2026-11-30', CONTACT);
    expect(c?.invoices).toHaveLength(1);
    expect(c?.totalByDate).toBe(100);
  });

  it('filters in SQL: the AR fetcher gets the company, the SAST day twice and the contact id', async () => {
    await getDueByDateContact(CO, 'ar', '2026-11-30', CONTACT);
    expect(fetchARAgingInvoices).toHaveBeenCalledTimes(1);
    expect(fetchARAgingInvoices).toHaveBeenCalledWith(CO, '2026-11-05', '2026-11-05', CONTACT);
    expect(fetchAPAgingInvoices).not.toHaveBeenCalled();
  });

  it('filters in SQL on the AP side too', async () => {
    const c = await getDueByDateContact(CO, 'ap', '2026-11-30', CONTACT);
    expect(fetchAPAgingInvoices).toHaveBeenCalledWith(CO, '2026-11-05', '2026-11-05', CONTACT);
    expect(fetchARAgingInvoices).not.toHaveBeenCalled();
    expect(c?.totalByDate).toBe(40);
  });

  it('the whole-side read still passes no contact', async () => {
    await getDueByDate(CO, 'ar', '2026-11-30');
    expect(fetchARAgingInvoices).toHaveBeenCalledWith(CO, '2026-11-05', '2026-11-05', null);
  });

  it('is null (the route answers 404) for a contact with nothing open', async () => {
    vi.mocked(fetchARAgingInvoices).mockResolvedValue([]);
    expect(await getDueByDateContact(CO, 'ar', '2026-11-30', CONTACT)).toBeNull();
  });

  it('is null, without a query, for an id that is not a UUID (it would be cast ::UUID)', async () => {
    expect(await getDueByDateContact(CO, 'ar', '2026-11-30', "1' OR '1'='1")).toBeNull();
    expect(fetchARAgingInvoices).not.toHaveBeenCalled();
  });

  it('refuses a past by_date before any query', async () => {
    await expect(getDueByDateContact(CO, 'ar', '2026-11-01', CONTACT)).rejects.toBeInstanceOf(DueByDateInputError);
    expect(fetchARAgingInvoices).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('are rethrown WITHOUT being logged here: the route wrapper and the MCP registry each log once', async () => {
    vi.mocked(fetchARAgingInvoices).mockRejectedValue(new Error('connection reset'));
    await expect(getDueByDate(CO, 'ar', '2026-11-30')).rejects.toThrow('connection reset');
    expect(logSpy.error).not.toHaveBeenCalled();
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
