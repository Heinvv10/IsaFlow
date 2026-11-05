/**
 * Due-by-date bucketing: pure function over the open-document rows the aging
 * services already produce. The footing test is the point of the report: the
 * four columns must add to what calculateAgingBuckets reports as the total.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDueByDateSide,
  byDateError,
  classifyDue,
  endOfMonth,
} from '@/modules/accounting/utils/dueByDate';
import { calculateAgingBuckets, type OpenAgingInvoice } from '@/modules/accounting/utils/aging';

const TODAY = '2026-11-05';
const BY = '2026-11-30';

let seq = 0;
function inv(over: Partial<OpenAgingInvoice> & { dueDate: string; balance: number }): OpenAgingInvoice {
  seq += 1;
  return {
    id: `i${seq}`,
    invoiceNumber: `INV-${seq}`,
    entityId: 'e1',
    entityName: 'Alpha',
    dueDateMissing: false,
    totalAmount: over.balance,
    amountPaid: 0,
    invoiceDate: '2026-10-01',
    reference: null,
    ...over,
  };
}

describe('classifyDue', () => {
  it('puts a null due date in noDueDate', () => {
    expect(classifyDue(null, TODAY, BY)).toBe('noDueDate');
  });
  it('yesterday is overdue; today is not', () => {
    expect(classifyDue('2026-11-04', TODAY, BY)).toBe('overdueNow');
    expect(classifyDue(TODAY, TODAY, BY)).toBe('dueTodayToDate');
  });
  it('exactly byDate is inside the window; the day after is later', () => {
    expect(classifyDue(BY, TODAY, BY)).toBe('dueTodayToDate');
    expect(classifyDue('2026-12-01', TODAY, BY)).toBe('dueLater');
  });
  it('byDate equal to today makes the window a single day', () => {
    expect(classifyDue(TODAY, TODAY, TODAY)).toBe('dueTodayToDate');
    expect(classifyDue('2026-11-06', TODAY, TODAY)).toBe('dueLater');
  });
});

describe('buildDueByDateSide', () => {
  const rows: OpenAgingInvoice[] = [
    inv({ dueDate: '2026-10-01', balance: 100.1 }),
    inv({ dueDate: TODAY, balance: 200.2 }),
    inv({ dueDate: BY, balance: 300.3 }),
    inv({ dueDate: '2026-12-15', balance: 400.4 }),
    // aging ages an undated invoice from its invoice date; here the raw NULL decides
    inv({ dueDate: '2026-09-01', dueDateMissing: true, balance: 500.5 }),
    inv({ dueDate: '2026-10-01', balance: 0 }),
    inv({ dueDate: '2026-10-01', balance: -50 }),
  ];

  it('fills the five columns and ignores zero or negative balances', () => {
    const side = buildDueByDateSide('ap', rows, TODAY, BY);
    expect(side.contacts).toHaveLength(1);
    expect(side.totals).toMatchObject({
      overdueNow: 100.1,
      dueTodayToDate: 500.5,
      totalByDate: 600.6,
      dueLater: 400.4,
      noDueDate: 500.5,
      total: 1501.5,
    });
    expect(side.contacts[0]!.invoices).toHaveLength(5);
  });

  it('a partially paid invoice counts its remaining balance only', () => {
    const side = buildDueByDateSide('ar', [
      inv({ dueDate: TODAY, totalAmount: 1000, amountPaid: 600, balance: 400 }),
    ], TODAY, BY);
    expect(side.totals.dueTodayToDate).toBe(400);
  });

  it('takes disputed amounts out of the columns, like the aging, and reports them apart', () => {
    const side = buildDueByDateSide('ar', [
      inv({ dueDate: '2026-10-01', balance: 1000, disputedAmount: 250 }),
      inv({ dueDate: '2026-12-01', balance: 100, disputedAmount: 999 }),
    ], TODAY, BY);
    expect(side.totals.overdueNow).toBe(750);
    expect(side.totals.dueLater).toBe(0);
    expect(side.totals.disputed).toBe(350);
    expect(side.contacts[0]!.invoices.map((i) => i.disputed)).toEqual([250, 100]);
  });

  it('groups by contact, orders by totalByDate then name, and totals across contacts', () => {
    const side = buildDueByDateSide('ap', [
      inv({ entityId: 'a', entityName: 'Alpha', dueDate: TODAY, balance: 10 }),
      inv({ entityId: 'b', entityName: 'Beta', dueDate: TODAY, balance: 30 }),
      inv({ entityId: 'b', entityName: 'Beta', dueDate: '2026-12-31', balance: 5 }),
    ], TODAY, BY);
    expect(side.contacts.map((c) => c.contactName)).toEqual(['Beta', 'Alpha']);
    expect(side.totals.totalByDate).toBe(40);
    expect(side.totals.dueLater).toBe(5);
  });

  it('adds cents exactly (0.1 + 0.2)', () => {
    const side = buildDueByDateSide('ap', [
      inv({ dueDate: TODAY, balance: 0.1 }),
      inv({ dueDate: TODAY, balance: 0.2 }),
    ], TODAY, BY);
    expect(side.totals.totalByDate).toBe(0.3);
  });

  it('FOOTING: overdue + due-to-date + later + no-due-date equals the aging total', () => {
    const mixed: OpenAgingInvoice[] = [
      ...rows,
      inv({ entityId: 'b', entityName: 'Beta', dueDate: '2026-08-01', balance: 1234.56, disputedAmount: 34.56 }),
      inv({ entityId: 'b', entityName: 'Beta', dueDate: '2026-11-20', totalAmount: 900, amountPaid: 450.25, balance: 449.75 }),
      inv({ entityId: 'c', entityName: 'Gamma', dueDate: '2027-02-01', dueDateMissing: true, balance: 77.77 }),
      inv({ entityId: 'c', entityName: 'Gamma', dueDate: '2026-11-01', balance: 0.01 }),
    ];
    const side = buildDueByDateSide('ar', mixed, TODAY, BY);
    const aging = calculateAgingBuckets(mixed, new Date(`${TODAY}T00:00:00`));
    const agingTotal = aging.reduce((s, r) => s + r.total, 0);
    const t = side.totals;
    expect(t.overdueNow + t.dueTodayToDate + t.dueLater + t.noDueDate).toBeCloseTo(agingTotal, 2);
    expect(t.total).toBeCloseTo(agingTotal, 2);
    // and per contact
    for (const c of side.contacts) {
      const a = aging.find((r) => r.entityId === c.contactId)!;
      expect(c.total).toBeCloseTo(a.total, 2);
      expect(c.disputed).toBeCloseTo(a.disputed ?? 0, 2);
    }
  });

  it('labels each invoice with its bucket and keeps the raw due date (null when missing)', () => {
    const side = buildDueByDateSide('ap', rows, TODAY, BY);
    const byBucket = side.contacts[0]!.invoices.map((i) => [i.bucket, i.dueDate]);
    expect(byBucket).toContainEqual(['noDueDate', null]);
    expect(byBucket).toContainEqual(['dueTodayToDate', BY]);
  });
});

describe('byDateError', () => {
  it('accepts today and later', () => {
    expect(byDateError(TODAY, TODAY)).toBeNull();
    expect(byDateError('2027-01-31', TODAY)).toBeNull();
  });
  it('refuses the past, junk, and impossible dates', () => {
    expect(byDateError('2026-11-04', TODAY)).toMatch(/today or later/);
    expect(byDateError('soon', TODAY)).toMatch(/YYYY-MM-DD/);
    expect(byDateError('2026-02-30', TODAY)).toMatch(/YYYY-MM-DD/);
    expect(byDateError('', TODAY)).toMatch(/YYYY-MM-DD/);
  });
});

describe('endOfMonth', () => {
  it('returns the last day of the month of the date given', () => {
    expect(endOfMonth('2026-11-05')).toBe('2026-11-30');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(endOfMonth('2026-12-31')).toBe('2026-12-31');
  });
});
