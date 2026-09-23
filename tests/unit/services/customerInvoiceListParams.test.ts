import { describe, it, expect } from 'vitest';
import { parseCustomerInvoiceListParams } from '@/modules/accounting/services/ar/customerInvoiceListParams';

const CLIENT = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

function ok(query: Record<string, unknown>) {
  const r = parseCustomerInvoiceListParams(query);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.filters;
}

describe('parseCustomerInvoiceListParams', () => {
  it('an empty query is the unfiltered first page, as before', () => {
    expect(ok({})).toEqual({
      status: null, clientId: null, search: null, agingFilters: [],
      dateFrom: null, dateTo: null, limit: 25, page: 1,
    });
  });

  it('keeps the existing status, search, aging and paging behaviour', () => {
    const f = ok({ status: 'all', q: '  INV-1 ', aging: 'overdue-90,bogus', limit: '500', page: '-3' });
    expect(f.status).toBeNull();
    expect(f.search).toBe('INV-1');
    expect(f.agingFilters).toEqual(['overdue-90']);
    expect(f.limit).toBe(100);
    expect(f.page).toBe(1);
    expect(ok({ status: ['sent', 'paid'] }).status).toEqual(['sent', 'paid']);
    expect(ok({ status: 'draft' }).status).toEqual(['draft']);
  });

  it('passes customer and inclusive date range through', () => {
    const f = ok({ client_id: CLIENT, from_date: '2026-06-01', to_date: '2026-06-30' });
    expect(f.clientId).toBe(CLIENT);
    expect(f.dateFrom).toBe('2026-06-01');
    expect(f.dateTo).toBe('2026-06-30');
  });

  it.each([
    [{ from_date: '2026-06-31' }, /from_date/],
    [{ to_date: 'june' }, /to_date/],
    [{ from_date: '2026-07-01', to_date: '2026-06-01' }, /on or before/],
    [{ client_id: "x' OR 1=1" }, /client_id/],
  ])('rejects %j', (query, message) => {
    const r = parseCustomerInvoiceListParams(query);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});
