import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { loadAgingPanelRows, daysOverdueAsAt } from '@/components/accounting/agingPanelRows';

const SUPPLIER = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const aging = (id: string, invoiceNumber: string, balance: number) => ({
  id, invoiceNumber, entityId: SUPPLIER, entityName: 'Acme', dueDate: '2026-05-01', totalAmount: 100, amountPaid: 100 - balance, balance,
});

afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('loadAgingPanelRows', () => {
  it('lists exactly the aging detail rows, including one paid since the as-at date, in one request', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ invoices: [aging('a', 'SI-1', 40), aging('paid-since', 'SI-2', 100)], buckets: null }));

    const rows = await loadAgingPanelRows('ap', SUPPLIER, '2026-06-30');

    expect(rows.map(r => [r.id, r.invoiceNumber, r.balance])).toEqual([['a', 'SI-1', 40], ['paid-since', 'SI-2', 100]]);
    expect(vi.mocked(apiFetch).mock.calls.map(c => c[0]))
      .toEqual([`/api/accounting/ap-aging?supplier_id=${SUPPLIER}&as_at_date=2026-06-30`]);
  });

  it('asks the AR detail by client_id', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ invoices: [] }));
    await expect(loadAgingPanelRows('ar', SUPPLIER, '2026-06-30')).resolves.toEqual([]);
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe(`/api/accounting/ar-aging?client_id=${SUPPLIER}&as_at_date=2026-06-30`);
  });

  it('throws on a 4xx instead of rendering an empty list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(loadAgingPanelRows('ap', SUPPLIER, '2026-06-30')).rejects.toThrow('Could not load the invoices - try again');
  });

  it('throws on a response with no data envelope', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(loadAgingPanelRows('ap', SUPPLIER, '2026-06-30')).rejects.toThrow('Could not load the invoices - try again');
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
