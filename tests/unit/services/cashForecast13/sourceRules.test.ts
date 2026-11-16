import { describe, it, expect } from 'vitest';
import { arItems, medianDaysLate, overdueSummary, type OpenArInvoice } from '@/modules/accounting/services/cashForecast13/arExpected';
import { payDatesInHorizon } from '@/modules/accounting/services/cashForecast13/payDates';
import { recurringItems, type RecurringTemplateRow } from '@/modules/accounting/services/cashForecast13/recurringItems';
import { toCents } from '@/modules/accounting/services/cashForecast13/lines';

const inv = (over: Partial<OpenArInvoice>): OpenArInvoice => ({
  id: 'i1', invoiceNumber: 'INV1', customerId: 'c1', customerName: 'Acme', dueDate: '2026-11-30', balanceCents: 1_000, disputedCents: 0, ...over,
});

const END = '2027-02-14';
function ar(invs: OpenArInvoice[], hist: Map<string, number[]>, today: string) {
  const r = arItems(invs, hist, today);
  return { items: r.items, summary: overdueSummary(r.items, r.disputedCents, END) };
}

describe('cash13 AR expected dates', () => {
  const today = '2026-11-18';

  it('the median of days late: odd, even (mean of the middle two, rounded), negatives kept', () => {
    expect(medianDaysLate([10, 2, 7])).toBe(7);
    expect(medianDaysLate([1, 2, 3, 6])).toBe(3); // 2.5 → 3
    expect(medianDaysLate([-4, -2, -1])).toBe(-2);
  });

  it('not yet due: the due date, basis due', () => {
    const { items } = ar([inv({})], new Map(), today);
    expect(items[0]).toMatchObject({ date: '2026-11-30', amountCents: 1_000, basis: 'due', lineKey: 'ar:c1:due' });
  });

  it('due today is not overdue', () => {
    const { items, summary } = ar([inv({ dueDate: today })], new Map(), today);
    expect(items[0]?.basis).toBe('due');
    expect(summary.invoiceCount).toBe(0);
  });

  it('overdue with 3 or more paid invoices: due + median days late, basis history', () => {
    const { items, summary } = ar([inv({ dueDate: '2026-11-10' })], new Map([['c1', [20, 30, 25]]]), today);
    expect(items[0]).toMatchObject({ date: '2026-12-05', basis: 'history', lineKey: 'ar:c1:history' });
    expect(summary).toMatchObject({ totalCents: 1_000, invoiceCount: 1, byBasis: { history: 1_000, no_history: 0 } });
  });

  it('overdue with only 2 paid invoices: week 1 (today), basis no_history', () => {
    const { items, summary } = ar([inv({ dueDate: '2026-11-10' })], new Map([['c1', [20, 30]]]), today);
    expect(items[0]).toMatchObject({ date: today, basis: 'no_history', lineKey: 'ar:c1:no_history' });
    expect(summary.byBasis).toEqual({ history: 0, no_history: 1_000 });
  });

  it('a history projection still before today keeps its date (the engine puts it in week 1)', () => {
    const { items } = ar([inv({ dueDate: '2026-09-01' })], new Map([['c1', [5, 5, 5]]]), today);
    expect(items[0]).toMatchObject({ date: '2026-09-06', basis: 'history' });
  });

  it('takes disputes out of the receipt and reports them; a fully disputed invoice is not expected', () => {
    const { items, summary } = ar([inv({ disputedCents: 400 }), inv({ id: 'i2', balanceCents: 300, disputedCents: 300 })], new Map(), today);
    expect(items.map((i) => i.amountCents)).toEqual([600]);
    expect(summary.disputedCents).toBe(700);
  });

  it('the overdue summary counts only what lands in the 13 weeks; a history date past them is beyondHorizonCents (review L4)', () => {
    const { summary } = ar([inv({ dueDate: '2026-11-10' }), inv({ id: 'i2', dueDate: '2026-11-10', customerId: 'c2', balanceCents: 700 })],
      new Map([['c1', [200, 200, 200]]]), today);
    // c1: 2026-11-10 + 200 days = 2027-05-29, past the horizon; c2 has no history → week 1.
    expect(summary).toMatchObject({ totalCents: 700, beyondHorizonCents: 1_000, invoiceCount: 1, byBasis: { history: 0, no_history: 700 } });
  });

  it('toCents rounds rand to integer cents', () => {
    expect(toCents(10.005)).toBe(1001);
    expect(toCents('1234.56')).toBe(123456);
    expect(toCents(-0.1 - 0.2)).toBe(-30);
  });
});

describe('cash13 pay dates', () => {
  it('pay day 25 in each month of the horizon, a weekend moved back to Friday', () => {
    // 2027-01-25 is a Monday; 2026-12-25 is a Friday; 2027-04-25 is a Sunday (outside a Nov horizon).
    expect(payDatesInHorizon(25, '2026-11-18', '2027-02-14', new Set())).toEqual(['2026-11-25', '2026-12-25', '2027-01-25']);
    expect(payDatesInHorizon(25, '2027-04-01', '2027-06-30', new Set())).toEqual(['2027-04-23', '2027-05-25', '2027-06-25']);
  });

  it('skips this month when the pay day has passed, or when the month is already paid', () => {
    expect(payDatesInHorizon(15, '2026-11-18', '2027-02-14', new Set())[0]).toBe('2026-12-15');
    expect(payDatesInHorizon(25, '2026-11-18', '2027-02-14', new Set(['2026-11']))[0]).toBe('2026-12-25');
  });

  it('last working day, and a day past a short month clamps to its last day first', () => {
    // 2027-01-31 is a Sunday → Friday 29th; 2027-02-28 is a Sunday → Friday 26th.
    expect(payDatesInHorizon('last_working_day', '2027-01-04', '2027-04-04', new Set())).toEqual(['2027-01-29', '2027-02-26', '2027-03-31']);
    expect(payDatesInHorizon(31, '2027-02-01', '2027-02-28', new Set())).toEqual(['2027-02-26']);
  });
});

describe('cash13 recurring receipts', () => {
  const tpl = (over: Partial<RecurringTemplateRow>): RecurringTemplateRow => ({
    id: 't1', name: 'Retainer', customerId: 'c1', customerName: 'Acme', frequency: 'monthly', nextRunDate: '2026-11-20', endDate: null, totalCents: 5_000, ...over,
  });
  const plus30 = (d: string) => {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 30);
    return dt.toISOString().slice(0, 10);
  };

  it('repeats by frequency and collects at run date + terms, within the horizon only', () => {
    const items = recurringItems([tpl({})], '2026-11-18', '2027-02-14', (_t, d) => plus30(d));
    // runs 11-20, 12-20, 01-20 (02-20 is past the horizon); receipts 30 days later; 2027-02-19 is past it too.
    expect(items.map((i) => i.date)).toEqual(['2026-12-20', '2027-01-19']);
    // entityId is the template's customer: what leftover customer credit nets against (re-review L-c).
    expect(items[0]).toMatchObject({ lineKey: 'recurring:t1', category: 'customer_receipts', amountCents: 5_000, entityId: 'c1' });
  });

  it('a run date already passed is invoiced today; the end date stops the series', () => {
    const items = recurringItems([tpl({ nextRunDate: '2026-10-01', frequency: 'weekly', endDate: '2026-10-15' })], '2026-11-18', '2027-02-14', (_t, d) => d);
    // 10-01, 10-08, 10-15: all invoiced today.
    expect(items.map((i) => i.date)).toEqual(['2026-11-18', '2026-11-18', '2026-11-18']);
  });
});
