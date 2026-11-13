import { describe, it, expect } from 'vitest';
import { parseIntent, INTENT_EXAMPLES } from '@/modules/accounting/services/ask/askIntents';
import { resolvePeriod } from '@/modules/accounting/services/ask/askPeriod';

describe('parseIntent', () => {
  it.each(INTENT_EXAMPLES.map((i) => [i.id, i.example]))('%s understands its own example', (id, example) => {
    expect(parseIntent(example)?.id).toBe(id);
  });

  it.each([
    ['customers owing me', 'owed_to_me'],
    ['show debtors', 'owed_to_me'],
    ['what is the bank balance', 'cash'],
    ['net profit year to date', 'profit'],
    ['how much vat is due', 'vat'],
    ['emp201 for last month', 'emp201'],
  ])('%s -> %s', (q, id) => expect(parseIntent(q)?.id).toBe(id));

  it('rejects questions outside the twelve, empty input and write requests', () => {
    for (const q of ['', 'ab', 'what is the weather', 'delete all invoices', 'post a journal']) {
      expect(parseIntent(q)).toBeNull();
    }
  });

  it('reads the window the question names', () => {
    expect(parseIntent('profit this month')?.period).toEqual({ kind: 'this_month' });
    expect(parseIntent('profit last month')?.period).toEqual({ kind: 'last_month' });
    expect(parseIntent('profit this year')?.period).toEqual({ kind: 'this_year' });
    expect(parseIntent('vat for october 2025')?.period).toEqual({ kind: 'month', month: 10, year: 2025 });
    expect(parseIntent('who owes me money')?.period).toBeNull();
  });
});

describe('resolvePeriod', () => {
  it('names a month without a year as the latest one not after today', () => {
    expect(resolvePeriod({ kind: 'month', month: 10, year: null }, '2026-11-13', 'month_to_date', '2026-03-01')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolvePeriod({ kind: 'month', month: 12, year: null }, '2026-11-13', 'month_to_date', '2026-03-01')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });
  it('last month crosses the year end; February has 28 or 29 days', () => {
    expect(resolvePeriod({ kind: 'last_month' }, '2026-01-05', 'month_to_date', '2026-03-01')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolvePeriod({ kind: 'month', month: 2, year: 2024 }, '2026-11-13', 'month_to_date', '2026-03-01').to).toBe('2024-02-29');
  });
  it('year to date starts where the registry says the financial year holding today starts', () => {
    expect(resolvePeriod({ kind: 'this_year' }, '2026-11-13', 'month_to_date', '2026-03-01')).toMatchObject({ from: '2026-03-01', to: '2026-11-13' });
    expect(resolvePeriod({ kind: 'this_year' }, '2026-02-13', 'month_to_date', '2025-03-01').from).toBe('2025-03-01');
  });
  it('defaults: month to date, or last month for the monthly EMP201', () => {
    expect(resolvePeriod(null, '2026-11-13', 'month_to_date', '2026-03-01')).toMatchObject({ from: '2026-11-01', to: '2026-11-13' });
    expect(resolvePeriod(null, '2026-11-13', 'last_month', '2026-03-01')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
  });
});
