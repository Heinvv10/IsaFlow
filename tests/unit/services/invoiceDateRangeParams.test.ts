import { describe, it, expect } from 'vitest';
import { parseInvoiceDateRange, isCalendarDate } from '@/modules/accounting/services/core/invoiceDateRangeParams';

describe('parseInvoiceDateRange', () => {
  it('treats absent and empty params as no range', () => {
    expect(parseInvoiceDateRange({})).toEqual({ ok: true, fromDate: undefined, toDate: undefined });
    expect(parseInvoiceDateRange({ from_date: '', to_date: '' })).toEqual({ ok: true, fromDate: undefined, toDate: undefined });
  });

  it('keeps valid inclusive bounds, including a single-day range', () => {
    expect(parseInvoiceDateRange({ from_date: '2026-06-01', to_date: '2026-06-30' }))
      .toEqual({ ok: true, fromDate: '2026-06-01', toDate: '2026-06-30' });
    expect(parseInvoiceDateRange({ from_date: '2026-06-15', to_date: '2026-06-15' }).ok).toBe(true);
  });

  it.each([
    ['from_date', '01/06/2026'],
    ['from_date', 'yesterday'],
    ['to_date', '2026-06-31'],
    ['to_date', '2026-02-29'],
    ['from_date', '2026-13-01'],
    ['from_date', '2026-06-00'],
    // Date.UTC maps years 0-99 to 19xx; Postgres rejects year 0 with a 500.
    ['from_date', '0000-01-01'],
    ['to_date', '0000-12-31'],
  ])('rejects %s=%s rather than dropping it', (key, value) => {
    const r = parseInvoiceDateRange({ [key]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(key);
  });

  it('rejects a repeated param (array) instead of picking one', () => {
    expect(parseInvoiceDateRange({ from_date: ['2026-06-01', '2026-07-01'] }).ok).toBe(false);
  });

  it('rejects an inverted range', () => {
    const r = parseInvoiceDateRange({ from_date: '2026-07-01', to_date: '2026-06-30' });
    expect(r.ok).toBe(false);
  });
});

describe('isCalendarDate', () => {
  it('knows leap years', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-12-31')).toBe(true);
    expect(isCalendarDate('1900-02-29')).toBe(false);
    expect(isCalendarDate('2000-02-29')).toBe(true);
    expect(isCalendarDate('0004-02-29')).toBe(false);
  });
});
