import { describe, it, expect } from 'vitest';
import { parseQuestion, parsePeriod, INTENT_EXAMPLES, type AskIntentId, type ParsedQuestion } from '@/modules/accounting/services/ask/askIntents';
import { resolveWindow, resolveAsAt, monthOf } from '@/modules/accounting/services/ask/askPeriod';

const idOf = (p: ParsedQuestion): string => (p.kind === 'intent' ? p.intent.id : p.kind === 'ambiguous' ? `ambiguous:${[...p.ids].sort().join('+')}` : 'none');

describe('parseQuestion', () => {
  it.each(INTENT_EXAMPLES.map((i) => [i.id, i.example]))('%s understands its own example', (id, example) => {
    expect(idOf(parseQuestion(example!))).toBe(id);
  });

  // Every one of these was routed to the wrong intent when the first matching pattern won.
  it.each<[string, string]>([
    ['What VAT is on my sales this month?', 'vat'],
    ['output VAT on sales', 'vat'],
    ['vat on expenses', 'vat'],
    ['PAYE cost last month', 'emp201'],
    ['UIF cost for October', 'emp201'],
    ['SDL expense', 'emp201'],
    ['How much income tax do I owe?', 'none'],
    ['Who owes me VAT?', 'ambiguous:owed_to_me+vat'],
    ['What did payroll cost last month?', 'last_pay_run'],
    ['what is my payroll cost', 'last_pay_run'],
    ['total assets and liabilities', 'ambiguous:assets+liabilities'],
    ['VAT liability', 'vat'],
    ['PAYE liability', 'emp201'],
    ['payroll liabilities', 'emp201'],
    ['what are my total liabilities', 'liabilities'],
    ['gross profit', 'profit'],
    ['cost of sales last month', 'expenses'],
    ['what can I spend?', 'none'],
    ['how much did I spend last month', 'expenses'],
    ['vat and profit', 'ambiguous:profit+vat'],
    ['profit & vat', 'ambiguous:profit+vat'],
    ['revenue, expenses', 'ambiguous:expenses+revenue'],
    ['who do I owe plus who owes me', 'ambiguous:i_owe+owed_to_me'],
    ['profit vs revenue', 'ambiguous:profit+revenue'],
    ['profit and loss', 'profit'],
    ['PAYE, UIF and SDL', 'emp201'],
    ['VAT on my sales and purchases', 'vat'],
    ['who owes me more than 2000', 'owed_to_me'],
  ])('%s -> %s', (q, expected) => expect(idOf(parseQuestion(q))).toBe(expected));

  it.each<[string, AskIntentId]>([
    ['customers owing me', 'owed_to_me'], ['show debtors', 'owed_to_me'], ['what is the bank balance', 'cash'],
    ['net profit year to date', 'profit'], ['how much vat is due', 'vat'], ['emp201 for last month', 'emp201'],
    ['what is my net income', 'profit'], ['how much did I spend last month', 'expenses'], ['turnover this year', 'revenue'],
  ])('%s -> %s', (q, id) => expect(idOf(parseQuestion(q))).toBe(id));

  it('rejects questions outside the twelve, empty input and write requests', () => {
    for (const q of ['', 'ab', 'what is the weather', 'delete all invoices', 'post a journal']) expect(parseQuestion(q).kind).toBe('none');
  });
});

describe('parsePeriod', () => {
  it('reads the windows it can honour', () => {
    expect(parsePeriod('profit this month')).toEqual({ kind: 'this_month' });
    expect(parsePeriod('profit last month')).toEqual({ kind: 'last_month' });
    expect(parsePeriod('profit this year')).toEqual({ kind: 'this_year' });
    expect(parsePeriod('profit last year')).toEqual({ kind: 'last_year' });
    expect(parsePeriod('vat for october 2025')).toEqual({ kind: 'month', month: 10, year: 2025 });
    expect(parsePeriod('who owes me money')).toBeNull();
  });
  it('quarters and halves are windows we cannot honour', () => {
    for (const [q, said] of [['profit in q3', 'q3'], ['profit first quarter', 'first quarter'], ['profit h1', 'h1'], ['profit for the half year', 'half year'], ['vat last quarter', 'quarter']]) {
      expect(parsePeriod(q!)).toEqual({ kind: 'unsupported', said });
    }
  });
  it('an amount is not a year; a year needs year context', () => {
    for (const q of ['who owes me more than 2000', 'who owes me over 2020', 'invoices under 1999', 'who owes me above 2005 rand']) expect(parsePeriod(q), q).toBeNull();
    expect(parsePeriod('profit in 2025')).toEqual({ kind: 'unsupported', said: '2025' });
    expect(parsePeriod('profit 2025')).toEqual({ kind: 'unsupported', said: '2025' });
    expect(parsePeriod('profit for fy 2025')).toEqual({ kind: 'unsupported', said: '2025' });
  });
  it('names a window it cannot honour instead of dropping it', () => {
    expect(parsePeriod('profit for 2025')).toEqual({ kind: 'unsupported', said: '2025' });
    expect(parsePeriod('profit last quarter')).toEqual({ kind: 'unsupported', said: 'quarter' });
    expect(parsePeriod('profit today')).toEqual({ kind: 'unsupported', said: 'today' });
  });
  it('"may" is a month only after a preposition or with a year', () => {
    expect(parsePeriod('what may i owe')).toBeNull();
    expect(parsePeriod('vat for may')).toEqual({ kind: 'month', month: 5, year: null });
    expect(parsePeriod('vat may 2026')).toEqual({ kind: 'month', month: 5, year: 2026 });
  });
});

describe('qualifiers', () => {
  it('gross and operating profit and cost of sales are carried as qualifiers', () => {
    const q = (t: string) => { const p = parseQuestion(t); return p.kind === 'intent' ? [p.intent.id, p.intent.qualifier] : p.kind; };
    expect(q('what is my gross profit')).toEqual(['profit', 'gross']);
    expect(q('operating profit last month')).toEqual(['profit', 'operating']);
    expect(q('cost of sales this year')).toEqual(['expenses', 'cost_of_sales']);
    expect(q('what is my profit')).toEqual(['profit', undefined]);
  });
});

describe('askPeriod', () => {
  const T = '2026-11-13';
  it('a named month without a year is the latest one not after today', () => {
    expect(resolveWindow({ kind: 'month', month: 10, year: null }, T, null)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveWindow({ kind: 'month', month: 12, year: null }, T, null)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });
  it('last month crosses the year end; February has 28 or 29 days', () => {
    expect(resolveWindow({ kind: 'last_month' }, '2026-01-05', null)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolveWindow({ kind: 'month', month: 2, year: 2024 }, T, null)?.to).toBe('2024-02-29');
  });
  it('this and last year come from the registry years, and are refused without them', () => {
    const fy = { thisStart: '2026-03-01', lastStart: '2025-03-01', lastEnd: '2026-02-28' };
    expect(resolveWindow({ kind: 'this_year' }, T, fy)).toMatchObject({ from: '2026-03-01', to: T });
    expect(resolveWindow({ kind: 'last_year' }, T, fy)).toMatchObject({ from: '2025-03-01', to: '2026-02-28' });
    expect(resolveWindow({ kind: 'this_year' }, T, null)).toBeNull();
    expect(resolveWindow({ kind: 'unsupported', said: '2025' }, T, fy)).toBeNull();
  });
  it('defaults to month to date', () => {
    expect(resolveWindow(null, T, null)).toMatchObject({ from: '2026-11-01', to: T });
  });
  it('as-at: today, end of a past month, never past today, and none for a year', () => {
    expect(resolveAsAt(null, T)?.date).toBe(T);
    expect(resolveAsAt({ kind: 'last_month' }, T)?.date).toBe('2026-10-31');
    expect(resolveAsAt({ kind: 'month', month: 11, year: 2026 }, T)?.date).toBe(T);
    expect(resolveAsAt({ kind: 'last_year' }, T)).toBeNull();
    expect(resolveAsAt({ kind: 'unsupported', said: '2025' }, T)).toBeNull();
  });
  it('monthOf defaults per intent', () => {
    expect(monthOf(null, T, 'last')).toEqual({ y: 2026, m: 10 });
    expect(monthOf(null, T, 'this')).toEqual({ y: 2026, m: 11 });
  });
});
