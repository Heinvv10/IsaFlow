/**
 * WP4b: the page size (25 / 50 / 100) is part of the bank-transactions view in the URL (`size`), like the page: the
 * default (25) is omitted, anything else is dropped, and a size round-trips through serialize and parse.
 */
import { describe, expect, it } from 'vitest';
import {
  BANK_TX_PAGE_SIZES, DEFAULT_FILTERS, parseUrlView, serializeUrlView, URL_KEYS, type UrlView,
} from '@/components/accounting/bank-transactions/bankTxUrlState';

const view = (filters: Partial<UrlView['filters']> = {}): UrlView =>
  ({ account: 'acc-1', tab: 'new', page: 1, filters: { ...DEFAULT_FILTERS, ...filters } });

describe('page size in the URL', () => {
  it('the choices are 25, 50 and 100, and 25 is the default', () => {
    expect(BANK_TX_PAGE_SIZES).toEqual([25, 50, 100]);
    expect(DEFAULT_FILTERS.pageSize).toBe(25);
    expect(URL_KEYS).toContain('size');
  });
  it('the default is not written; 50 and 100 are', () => {
    expect(serializeUrlView(view())).not.toHaveProperty('size');
    expect(serializeUrlView(view({ pageSize: 50 }))).toMatchObject({ size: '50' });
    expect(serializeUrlView(view({ pageSize: 100 }))).toMatchObject({ size: '100' });
  });
  it('parses 50 and 100; drops anything else (a size the list does not offer is not trusted)', () => {
    expect(parseUrlView({ size: '50' }).filters.pageSize).toBe(50);
    expect(parseUrlView({ size: '100' }).filters.pageSize).toBe(100);
    for (const junk of ['25', '10', '1000', '50.0', 'abc', '', '-50']) expect(parseUrlView({ size: junk }).filters).not.toHaveProperty('pageSize');
    expect(parseUrlView({ size: ['50', '100'] }).filters).not.toHaveProperty('pageSize');
  });
  it('round-trips', () => {
    const q = serializeUrlView(view({ pageSize: 100 }));
    expect({ ...DEFAULT_FILTERS, ...parseUrlView(q).filters }.pageSize).toBe(100);
  });
});
