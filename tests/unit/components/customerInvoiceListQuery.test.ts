import { describe, it, expect } from 'vitest';
import {
  hydrateARFilters, arFiltersToQuery, arFiltersToApiParams, AR_DEFAULTS,
} from '@/components/accounting/customer-invoices/listQuery';

const CUSTOMER = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

describe('customer invoice list URL state', () => {
  it('an empty URL is the default view and writes back an empty query', () => {
    expect(hydrateARFilters({})).toEqual(AR_DEFAULTS);
    expect(arFiltersToQuery(AR_DEFAULTS)).toEqual({});
  });

  it('round-trips every filter through the URL', () => {
    const query = {
      status: 'sent', q: 'INV-9', customer: CUSTOMER, from: '2026-06-01', to: '2026-06-30',
      aging: 'overdue-90,viewed-unpaid', page: '3',
    };
    const f = hydrateARFilters(query);
    expect(f).toEqual({
      status: 'sent', search: 'INV-9', customerId: CUSTOMER, from: '2026-06-01', to: '2026-06-30',
      aging: ['overdue-90', 'viewed-unpaid'], page: 3,
    });
    expect(arFiltersToQuery(f)).toEqual(query);
  });

  it('still honours the legacy ?filter= status deep link', () => {
    expect(hydrateARFilters({ filter: 'draft' }).status).toBe('draft');
    expect(hydrateARFilters({ status: 'paid', filter: 'draft' }).status).toBe('paid');
  });

  it('drops values a hand-edited URL got wrong instead of breaking the page', () => {
    const f = hydrateARFilters({ status: 'bogus', customer: 'not-a-uuid', from: '2026-06-31', page: 'x' });
    expect(f).toEqual(AR_DEFAULTS);
    const inverted = hydrateARFilters({ from: '2026-07-01', to: '2026-06-01' });
    expect([inverted.from, inverted.to]).toEqual(['', '']);
  });

  it('maps page filters onto the API params the list and export routes take', () => {
    const f = hydrateARFilters({ status: 'approved', customer: CUSTOMER, from: '2026-06-01', to: '2026-06-30', page: '2' });
    expect(arFiltersToApiParams(f)).toEqual({
      status: 'approved', client_id: CUSTOMER, from_date: '2026-06-01', to_date: '2026-06-30',
    });
  });
});
