import { describe, it, expect } from 'vitest';
import {
  expectedVatPeriodAsOf,
  normalizeVatCadence,
  normalizeVatAlignment,
  vatQuickPeriods,
  defaultVatQuickPeriod,
} from '@/modules/bureau/services/vatPeriodHelper';

describe('expectedVatPeriodAsOf', () => {
  it('odd alignment in June returns the May-ending period', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-06-08T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-04-01', periodEnd: '2026-05-31', dueDate: '2026-06-25' });
  });

  it('even alignment in June returns the April-ending period', () => {
    const p = expectedVatPeriodAsOf('even', new Date('2026-06-08T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-03-01', periodEnd: '2026-04-30', dueDate: '2026-05-25' });
  });

  it('skips a parity month that has not fully ended yet', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-05-15T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-03-31', dueDate: '2026-04-25' });
  });

  it('wraps across the year boundary', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-01-10T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2025-10-01', periodEnd: '2025-11-30', dueDate: '2025-12-25' });
  });

  it('includes a period whose end day matches asOf exactly', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-05-31T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-04-01', periodEnd: '2026-05-31', dueDate: '2026-06-25' });
  });

  it('monthly cadence returns the most recent fully-ended calendar month', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-06-08T00:00:00Z'), 'monthly');
    expect(p).toEqual({ periodStart: '2026-05-01', periodEnd: '2026-05-31', dueDate: '2026-06-25' });
  });

  it('monthly cadence includes a month ending exactly on asOf', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-05-31T00:00:00Z'), 'monthly');
    expect(p).toEqual({ periodStart: '2026-05-01', periodEnd: '2026-05-31', dueDate: '2026-06-25' });
  });

  it('monthly cadence wraps across the year boundary', () => {
    const p = expectedVatPeriodAsOf('odd', new Date('2026-01-10T00:00:00Z'), 'monthly');
    expect(p).toEqual({ periodStart: '2025-12-01', periodEnd: '2025-12-31', dueDate: '2026-01-25' });
  });

  it('monthly cadence ignores alignment parity', () => {
    const odd = expectedVatPeriodAsOf('odd', new Date('2026-06-08T00:00:00Z'), 'monthly');
    const even = expectedVatPeriodAsOf('even', new Date('2026-06-08T00:00:00Z'), 'monthly');
    expect(odd).toEqual(even);
  });
});

describe('normalizeVatCadence', () => {
  it('maps monthly case-insensitively', () => {
    expect(normalizeVatCadence('monthly')).toBe('monthly');
    expect(normalizeVatCadence('Monthly')).toBe('monthly');
    expect(normalizeVatCadence('MONTHLY')).toBe('monthly');
  });

  it('defaults everything else to bi-monthly (incl. legacy capitalized rows)', () => {
    expect(normalizeVatCadence('bi-monthly')).toBe('bi-monthly');
    expect(normalizeVatCadence('Bi-Monthly')).toBe('bi-monthly');
    expect(normalizeVatCadence(null)).toBe('bi-monthly');
    expect(normalizeVatCadence(undefined)).toBe('bi-monthly');
    expect(normalizeVatCadence('')).toBe('bi-monthly');
  });
});

describe('normalizeVatAlignment', () => {
  it('maps even case-insensitively and defaults to odd', () => {
    expect(normalizeVatAlignment('even')).toBe('even');
    expect(normalizeVatAlignment('Even')).toBe('even');
    expect(normalizeVatAlignment('odd')).toBe('odd');
    expect(normalizeVatAlignment(null)).toBe('odd');
    expect(normalizeVatAlignment(undefined)).toBe('odd');
  });
});

describe('vatQuickPeriods', () => {
  it('odd (Category A) builds the six periods ENDING in odd months of the year', () => {
    const periods = vatQuickPeriods(2026, 'bi-monthly', 'odd');
    expect(periods).toHaveLength(6);
    expect(periods[0]).toEqual({ label: 'Dec–Jan 2025/2026', from: '2025-12-01', to: '2026-01-31' });
    expect(periods[1]).toEqual({ label: 'Feb–Mar 2026', from: '2026-02-01', to: '2026-03-31' });
    expect(periods[5]).toEqual({ label: 'Oct–Nov 2026', from: '2026-10-01', to: '2026-11-30' });
  });

  it('even (Category B) builds the six periods ENDING in even months of the year', () => {
    const periods = vatQuickPeriods(2026, 'bi-monthly', 'even');
    expect(periods).toHaveLength(6);
    expect(periods[0]).toEqual({ label: 'Jan–Feb 2026', from: '2026-01-01', to: '2026-02-28' });
    expect(periods[5]).toEqual({ label: 'Nov–Dec 2026', from: '2026-11-01', to: '2026-12-31' });
  });

  it('even alignment is leap-aware for February', () => {
    const periods = vatQuickPeriods(2028, 'bi-monthly', 'even');
    expect(periods[0]).toEqual({ label: 'Jan–Feb 2028', from: '2028-01-01', to: '2028-02-29' });
  });

  it('monthly builds the twelve calendar months of the year', () => {
    const periods = vatQuickPeriods(2026, 'monthly', 'odd');
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ label: 'Jan 2026', from: '2026-01-01', to: '2026-01-31' });
    expect(periods[11]).toEqual({ label: 'Dec 2026', from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('defaultVatQuickPeriod', () => {
  it('picks the period containing asOf (odd → Jun–Jul holds June 8)', () => {
    const p = defaultVatQuickPeriod('bi-monthly', 'odd', new Date('2026-06-08T00:00:00Z'));
    expect(p).toMatchObject({ from: '2026-06-01', to: '2026-07-31' });
  });

  it('crosses the year boundary for a December date on odd alignment', () => {
    const p = defaultVatQuickPeriod('bi-monthly', 'odd', new Date('2026-12-15T00:00:00Z'));
    expect(p).toMatchObject({ from: '2026-12-01', to: '2027-01-31' });
  });

  it('picks the containing calendar month for monthly cadence', () => {
    const p = defaultVatQuickPeriod('monthly', 'odd', new Date('2026-06-08T00:00:00Z'));
    expect(p).toMatchObject({ from: '2026-06-01', to: '2026-06-30' });
  });
});
