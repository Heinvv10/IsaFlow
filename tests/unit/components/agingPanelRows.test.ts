import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { loadAgingPanelRows, daysOverdueAsAt } from '@/components/accounting/agingPanelRows';

const SUPPLIER = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const aging = (id: string, balance: number) => ({
  id, entityId: SUPPLIER, entityName: 'Acme', dueDate: '2026-05-01', totalAmount: 100, amountPaid: 100 - balance, balance,
});

afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('loadAgingPanelRows', () => {
  it('lists exactly the aging detail rows, including one paid since the as-at date', async () => {
    const urls: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.startsWith('/api/accounting/ap-aging?')) {
        return ok({ invoices: [aging('a', 40), aging('paid-since', 100)], buckets: null });
      }
      // Two list pages: 200 rows (none wanted) then the page carrying both ids.
      if (url.includes('offset=0')) {
        return ok({ invoices: Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, invoiceNumber: `X${i}` })), total: 202 });
      }
      return ok({ invoices: [{ id: 'a', invoiceNumber: 'SI-1' }, { id: 'paid-since', invoiceNumber: 'SI-2' }], total: 202 });
    });

    const rows = await loadAgingPanelRows('ap', SUPPLIER, '2026-06-30');

    expect(rows.map(r => [r.id, r.invoiceNumber, r.balance])).toEqual([['a', 'SI-1', 40], ['paid-since', 'SI-2', 100]]);
    expect(urls[0]).toBe(`/api/accounting/ap-aging?supplier_id=${SUPPLIER}&as_at_date=2026-06-30`);
    // The number lookup is unfiltered by balance, so a since-paid invoice still resolves.
    expect(urls.slice(1)).toEqual([
      `/api/accounting/supplier-invoices?supplier_id=${SUPPLIER}&limit=200&offset=0`,
      `/api/accounting/supplier-invoices?supplier_id=${SUPPLIER}&limit=200&offset=200`,
    ]);
  });

  it('stops paging once every number is found, and leaves an unresolvable one null', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/accounting/ar-aging?')) return ok({ invoices: [aging('a', 10), aging('gone', 5)] });
      return ok({ invoices: [{ id: 'a', invoice_number: 'INV-1' }], total: 1 });
    });

    const rows = await loadAgingPanelRows('ar', SUPPLIER, '2026-06-30');

    expect(rows.map(r => r.invoiceNumber)).toEqual(['INV-1', null]);
    expect(vi.mocked(apiFetch).mock.calls.map(c => c[0])).toEqual([
      `/api/accounting/ar-aging?client_id=${SUPPLIER}&as_at_date=2026-06-30`,
      `/api/accounting/customer-invoices-list?client_id=${SUPPLIER}&limit=100&page=1`,
    ]);
  });

  it('skips the number lookup when there is nothing outstanding', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ invoices: [] }));
    await expect(loadAgingPanelRows('ar', SUPPLIER, '2026-06-30')).resolves.toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('throws on a 4xx instead of rendering an empty list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(loadAgingPanelRows('ap', SUPPLIER, '2026-06-30')).rejects.toThrow('HTTP 403');
  });

  it('throws when a number lookup page fails', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(ok({ invoices: [aging('a', 1)] }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(loadAgingPanelRows('ap', SUPPLIER, '2026-06-30')).rejects.toThrow('HTTP 500');
  });
});

describe('daysOverdueAsAt', () => {
  it('counts whole days from due date to the as-at date, never negative', () => {
    expect(daysOverdueAsAt('2026-05-01', '2026-05-31')).toBe(30);
    expect(daysOverdueAsAt('2026-05-31', '2026-05-31')).toBe(0);
    expect(daysOverdueAsAt('2026-06-30', '2026-05-31')).toBe(0);
    // pg Date objects arrive stringified this way through String(date).
    expect(daysOverdueAsAt(String(new Date(2026, 4, 1)), '2026-05-11')).toBe(10);
  });
});
