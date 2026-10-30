import { describe, expect, it } from 'vitest';
import { datePayload, endBeforeNextRefused, editLines, rawLineItems } from '@/components/accounting/recurringInvoices/recurringEditDates';

const loaded = { nextRunDate: '2026-11-01', endDate: '2026-12-31' };

describe('datePayload', () => {
  it('omits endDate when unchanged', () => {
    expect(datePayload(loaded, loaded)).toEqual({});
  });
  it('sends only nextRunDate when only it changed', () => {
    const p = datePayload({ ...loaded, nextRunDate: '2026-12-01' }, loaded);
    expect(p).toEqual({ nextRunDate: '2026-12-01' });
    expect('endDate' in p).toBe(false);
  });
  it('sends both when both changed', () => {
    expect(datePayload({ nextRunDate: '2026-12-01', endDate: '2027-02-01' }, loaded))
      .toEqual({ nextRunDate: '2026-12-01', endDate: '2027-02-01' });
  });
  it('sends neither key when neither changed', () => {
    const p = datePayload(loaded, loaded);
    expect('nextRunDate' in p || 'endDate' in p).toBe(false);
  });
  it('sends null when cleared and the new value when changed', () => {
    expect(datePayload({ ...loaded, endDate: '' }, loaded)).toEqual({ endDate: null });
    expect(datePayload({ ...loaded, endDate: '2027-01-31' }, loaded).endDate).toBe('2027-01-31');
  });
  it('omits endDate when there was none and none was entered', () => {
    const none = { nextRunDate: '2026-11-01', endDate: '' };
    expect('endDate' in datePayload(none, none)).toBe(false);
  });
});

describe('endBeforeNextRefused', () => {
  const legacy = { nextRunDate: '2026-11-01', endDate: '2026-10-01' };
  it('allows an unchanged legacy end<next row', () => {
    expect(endBeforeNextRefused(legacy, legacy)).toBe(false);
  });
  it('refuses when either date changed and end<next', () => {
    expect(endBeforeNextRefused({ ...legacy, nextRunDate: '2026-12-01' }, legacy)).toBe(true);
    expect(endBeforeNextRefused({ ...loaded, endDate: '2026-10-01' }, loaded)).toBe(true);
  });
  it('never refuses an empty end date', () => {
    expect(endBeforeNextRefused({ nextRunDate: '2026-11-01', endDate: '' }, loaded)).toBe(false);
  });
});

describe('rawLineItems / editLines', () => {
  it('reads camelCase lineItems', () => {
    const found = { lineItems: [{ description: 'A', quantity: 2, unitPrice: 5, glAccountId: 'g1' }] };
    expect(rawLineItems(found)).toHaveLength(1);
    expect(editLines(found)).toEqual([{ key: '0', description: 'A', quantity: 2, unitPrice: 5, glAccountId: 'g1' }]);
  });
  it('falls back to snake_case line_items', () => {
    const found = { line_items: [{ description: 'B', unit_price: 7, gl_account_id: 'g2' }] };
    expect(editLines(found)).toEqual([{ key: '0', description: 'B', quantity: 1, unitPrice: 7, glAccountId: 'g2' }]);
  });
  it('returns [] when neither is present or not an array', () => {
    expect(rawLineItems({})).toEqual([]);
    expect(editLines({})).toEqual([]);
    expect(editLines({ lineItems: 'x', line_items: null })).toEqual([]);
  });
});
