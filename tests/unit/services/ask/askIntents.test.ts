import { describe, it, expect } from 'vitest';
import { parseQuestion, parsePeriod, INTENT_EXAMPLES, type AskIntentId, type ParsedQuestion } from '@/modules/accounting/services/ask/askIntents';
import { resolveWindow, resolveAsAt, monthOf, missingDayNote } from '@/modules/accounting/services/ask/askPeriod';

const idOf = (p: ParsedQuestion): string => (p.kind === 'intent' ? p.intent.id : p.kind === 'ambiguous' ? `ambiguous:${[...p.ids].sort().join('+')}` : p.kind === 'unsupported' ? `unsupported:${p.id}` : p.kind === 'periods' ? `periods:${p.id}` : p.kind === 'leftover' ? `leftover:${p.id}` : 'none');

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
    ['who owes me more than 2000', 'unsupported:owed_to_me'],
    ['who owes me more than R2000', 'unsupported:owed_to_me'],
    ['customers owing more than 2000', 'unsupported:owed_to_me'],
    ['who owes me under 500', 'unsupported:owed_to_me'],
    ['How much cash, roughly, is in the bank?', 'cash'],
    ['what is my profit, roughly, this month', 'profit'],
    ['net profit vs last month', 'unsupported:profit'],
    ['profit compared to last month', 'unsupported:profit'],
    ['profit before tax', 'unsupported:profit'],
    ['profit after tax', 'unsupported:profit'],
    ['revenue excluding vat', 'unsupported:revenue'],
    ['expenses incl vat', 'unsupported:expenses'],
    ['profit including VAT', 'unsupported:profit'],
    ['revenue net of vat', 'unsupported:revenue'],
    ['expenses net of VAT', 'unsupported:expenses'],
    ['profit net of tax', 'unsupported:profit'],
    ['revenue after vat', 'unsupported:revenue'],
    ['revenue before vat', 'unsupported:revenue'],
    ['what vat is payable this month', 'vat'],
    ['vat payable', 'vat'],
    ['payables', 'i_owe'],
    ['who do I owe vat', 'ambiguous:i_owe+vat'],
    ['what vat do I owe', 'vat'],
    ['profit gross', 'profit'],
    ['profit, operating', 'ambiguous:profit'],
    ['revenue over 12 months', 'revenue'],
    ['profit this year vs last year', 'periods:profit'],
    ['profit this month vs last month', 'periods:profit'],
    ['profit last month and this month', 'periods:profit'],
    ['vat for october and november', 'periods:vat'],
    ['gross profit and net profit', 'ambiguous:profit'],
    ['gross profit and operating profit', 'ambiguous:profit'],
    ['cost of sales and expenses', 'ambiguous:expenses'],
    ['cost of sales and revenue', 'ambiguous:expenses+revenue'],
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
    expect(parsePeriod('profit for fy 2025')).toEqual({ kind: 'fy', year: 2025 });
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

describe('ambiguous and multi-window replies offer the choices', () => {
  it('two figures of one intent offer one question each', () => {
    const p = parseQuestion('gross profit and net profit');
    expect(p.kind === 'ambiguous' && p.examples).toEqual(['What is my gross profit this month?', 'What is my profit this month?']);
    const q = parseQuestion('cost of sales and expenses');
    expect(q.kind === 'ambiguous' && q.examples).toEqual(['What is my cost of sales this month?', 'What are my expenses last month?']);
  });
  it('several windows offer one question per window', () => {
    const p = parseQuestion('profit this year vs last year');
    expect(p.kind === 'periods' && p.examples).toEqual(['What is my profit last year?', 'What is my profit this year?']);
    const q = parseQuestion('what vat do I owe for october and november');
    expect(q.kind === 'periods' && q.examples).toEqual(['What VAT do I owe in October?', 'What VAT do I owe in November?']);
  });
});

describe('ambiguous replies keep the window the person named', () => {
  it('revenue and expenses last month suggests last month, not the default', () => {
    const p = parseQuestion('revenue and expenses last month');
    expect(p.kind === 'ambiguous' && p.examples).toEqual(['What is my revenue last month?', 'What are my expenses last month?']);
    const q = parseQuestion('gross profit and net profit in october');
    expect(q.kind === 'ambiguous' && q.examples).toEqual(['What is my gross profit in October?', 'What is my profit in October?']);
  });
  it('a window that is not named leaves the intents\' own examples', () => {
    const p = parseQuestion('revenue and expenses');
    expect(p.kind === 'ambiguous' && p.examples).toEqual(['What is my revenue this year?', 'What are my expenses last month?']);
  });
});

describe('aging buckets and durations', () => {
  it.each([['who owes me over 90 days'], ['customers owing more than 60 days'], ['who owes me overdue'], ['who owes me older than 30 days']])('%s: refused as an aging bucket', (q) => {
    const p = parseQuestion(q);
    expect(p.kind === 'unsupported' && p.said).toBe('by aging bucket');
  });
  it('a duration after "over" is not an amount; an amount still is', () => {
    const q = parseQuestion('profit over 12 months');
    expect(q.kind === 'intent' && q.intent.period).toEqual({ kind: 'unsupported', said: '12 months' });
    const p = parseQuestion('who owes me over 2000');
    expect(p.kind === 'unsupported' && p.said).toContain('amount filters');
  });
});

describe('windows we do not support are refused, never dropped', () => {
  it.each([['profit last 30 days', '30 days'], ['revenue past 3 months', 'past 3 months'], ['expenses since march', 'since march'], ['profit next month', 'next month'],
    ['profit last week', 'last week'], ['revenue over 12 months', '12 months'], ['who owes me over 30 days', '30 days'], ['profit last 6 months', '6 months']])('%s', (q, said) => {
    const p = parsePeriod(q);
    expect(p && p.kind === 'unsupported' && p.said).toContain(said.split(' ')[0]);
  });
  it('supported windows are not caught by it', () => {
    for (const q of ['profit last month', 'profit this month', 'profit last year', 'profit year to date']) expect(parsePeriod(q)?.kind).not.toBe('unsupported');
  });
});

describe('two exact days are two windows', () => {
  it('as at 15 october and 20 october asks one period at a time', () => {
    const p = parseQuestion('who owes me money as at 15 october and 20 october');
    expect(p.kind).toBe('periods');
    expect(p.kind === 'periods' && p.examples).toEqual(['Who owes me money as at 15 October?', 'Who owes me money as at 20 October?']);
  });
  it('a day and a month are two windows; a single day is one', () => {
    expect(parseQuestion('total assets as at 15 october and november').kind).toBe('periods');
    expect(parseQuestion('total assets as at 15 october').kind).toBe('intent');
  });
});

describe('every content word is accounted for, or the question is refused', () => {
  it.each([
    ['profit by customer', 'leftover:profit'], ['revenue from acme', 'leftover:revenue'], ['expenses for rent', 'leftover:expenses'],
    ['top 5 customers who owe me', 'leftover:owed_to_me'], ['profit mid october', 'leftover:profit'], ['revenue for the period ending october', 'leftover:revenue'],
    ['who owes me money in cape town', 'leftover:owed_to_me'], ['cash in the bank at fnb', 'leftover:cash'], ['expenses on fuel', 'leftover:expenses'],
  ])('%s -> %s', (q, expected) => expect(idOf(parseQuestion(q))).toBe(expected));

  it('names the leftover words', () => {
    const p = parseQuestion('revenue from acme');
    expect(p.kind === 'leftover' && p.words).toEqual(['from', 'acme']);
  });
  it('every phrasing that answers still answers (the whole collision vocabulary)', () => {
    for (const q of ['What VAT is on my sales this month?', 'output VAT on sales', 'PAYE cost last month', 'What did payroll cost last month?', 'How much cash, roughly, is in the bank?',
      'show debtors', 'customers owing me', 'what is the bank balance', 'net profit year to date', 'how much vat is due', 'emp201 for last month', 'what is my net income',
      'how much did I spend last month', 'turnover this year', 'profit and loss', 'VAT on my sales and purchases', 'who owes me money as at 15 october',
      'total assets as at 3 march 2026', 'what vat do I owe for october 2025', 'please show me my total liabilities', 'what is my gross profit this month', 'cost of sales last month']) {
      expect(['intent', 'ambiguous'], q).toContain(parseQuestion(q).kind);
    }
  });
  it('a refinement we refuse for another reason is not reported as leftover words', () => {
    expect(idOf(parseQuestion('profit in q3 by customer'))).toBe('profit');
  });
});

describe('the refusal quotes the words as the person typed them', () => {
  it('doesn\'t, not "not"', () => {
    const p = parseQuestion("who doesn't owe me");
    expect(p.kind === 'leftover' && p.words).toEqual(["doesn't"]);
    const q = parseQuestion('revenue from acme');
    expect(q.kind === 'leftover' && q.words).toEqual(['from', 'acme']);
  });
});

describe('the future is refused as a forecast, not as unknown words', () => {
  it.each(['will we make a profit', 'what will my profit be', 'are we going to make a profit', 'forecast revenue', 'what is our expected profit', 'projected expenses'])('%s', (q) => {
    const p = parseQuestion(q);
    expect(p.kind === 'unsupported' && p.said).toBe('forecasts');
  });
  it('bank and lender debt is refused as such, not answered as supplier debt', () => {
    for (const q of ['how much do we owe the bank', 'what do we owe on our loan', 'what do we owe the lenders']) {
      const p = parseQuestion(q);
      expect(p.kind === 'unsupported' && p.said, q).toBe('what is owed to the bank or lenders');
    }
  });
});

describe('numeric dates are part of a window, not leftover words', () => {
  it.each([['total assets as at 2026-10-15', 10, 15, 2026], ['total assets as at 15/10/2026', 10, 15, 2026], ['who owes me money on 15-10-2026', 10, 15, 2026]])('%s', (q, month, day, year) => {
    const p = parseQuestion(q);
    expect(p.kind === 'intent' && p.intent.period).toEqual({ kind: 'day', day, month, year });
  });
  it('an impossible numeric date is refused, not read as another day', () => {
    const p = parseQuestion('total assets as at 2026-02-30');
    expect(p.kind === 'intent' && p.intent.period).toEqual({ kind: 'unsupported', said: '2026 02 30' });
  });
  it('two numeric dates are two windows', () => {
    expect(parseQuestion('total assets as at 2026-10-15 and 2026-10-20').kind).toBe('periods');
  });
});

describe('everyday words around a question', () => {
  it.each(['what is my account balance', 'what is my current bank balance', 'how much cash do we have right now', 'how much profit so far this year', 'what is my total balance sheet assets',
    'what are our total liabilities overall', 'what is my company profit this month', 'show me my bank statement balance thanks',
    'what is the cash position at the moment', 'how much money do we have in the bank accounts', 'revenue so far'])('%s still answers', (q) => {
    expect(['intent', 'ambiguous'], q).toContain(parseQuestion(q).kind);
  });
});

describe('everyday words that are not accounted for are refused, not dropped', () => {
  it.each([['what does my vat return say for october', 'leftover:vat'], ['what is my profit and why', 'leftover:profit']])('%s -> %s', (q, expected) => {
    expect(idOf(parseQuestion(q))).toBe(expected);
  });
});

describe('month abbreviations and financial years', () => {
  it('abbreviated months read as the month', () => {
    for (const [q, month] of [['vat for oct', 10], ['profit in sept', 9], ['emp201 for jan 2026', 1], ['profit dec', 12], ['revenue for feb', 2]] as const) {
      const p = parseQuestion(q);
      expect(p.kind === 'intent' && p.intent.period, q).toMatchObject({ kind: 'month', month });
    }
  });
  it.each(['profit fy2026', 'profit FY 2026', 'profit financial year 2026', 'profit 2026 financial year', 'revenue for the 2026 fiscal year'])('%s is financial year 2026', (q) => {
    const p = parseQuestion(q);
    expect(p.kind === 'intent' && p.intent.period).toEqual({ kind: 'fy', year: 2026 });
  });
});

describe('a day range on a statement is refused, never offered as "as at"', () => {
  it('profit for 1 october to 31 october', () => {
    const p = parseQuestion('what is my profit from 1 october to 31 october');
    expect(p.kind === 'unsupported' && p.said).toBe('a single day or a date range');
  });
  it('a position still gets "as at" examples for two days', () => {
    const p = parseQuestion('total assets as at 1 october and 31 october');
    expect(p.kind === 'periods' && p.examples[0]).toContain('as at 1 October');
  });
});

describe('"this period"', () => {
  it('is the current month window, so the VAT answer takes the company\'s current period', () => {
    expect(parsePeriod('vat for this period')).toEqual({ kind: 'this_month' });
    expect(parsePeriod('vat for the current period')).toEqual({ kind: 'this_month' });
  });
});

describe('exact days', () => {
  it('reads a day with its month (and year)', () => {
    expect(parsePeriod('as at 15 october')).toEqual({ kind: 'day', day: 15, month: 10, year: null });
    expect(parsePeriod('on the 3rd of march 2026')).toEqual({ kind: 'day', day: 3, month: 3, year: 2026 });
    expect(parsePeriod('as at october 15th')).toEqual({ kind: 'day', day: 15, month: 10, year: null });
    expect(parsePeriod('as at 2026-10-15')).toEqual({ kind: 'day', day: 15, month: 10, year: 2026 });
  });
  it('an impossible day is refused, never turned into its month', () => {
    expect(parsePeriod('as at 31 april')).toEqual({ kind: 'unsupported', said: '31 april' });
    expect(parsePeriod('as at 30 february 2026')).toEqual({ kind: 'unsupported', said: '30 february 2026' });
  });
});

describe('qualifiers', () => {
  it('gross and operating profit and cost of sales are carried as qualifiers', () => {
    const q = (t: string) => { const p = parseQuestion(t); return p.kind === 'intent' ? [p.intent.id, p.intent.qualifier] : p.kind; };
    expect(q('what is my gross profit')).toEqual(['profit', 'gross']);
    expect(q('operating profit last month')).toEqual(['profit', 'operating']);
    expect(q('cost of sales this year')).toEqual(['expenses', 'cost_of_sales']);
    expect(q('what is my profit')).toEqual(['profit', undefined]);
    expect(q('profit gross')).toEqual(['profit', 'gross']);
    expect(q('income operating')).toEqual(['profit', 'operating']);
  });
});

describe('askPeriod days', () => {
  it('a yearless day is the latest occurrence not after today (within 12 months); one not on that year\'s calendar is refused, never read as another year', () => {
    expect(resolveAsAt({ kind: 'day', day: 29, month: 2, year: null }, '2026-11-13')).toBeNull(); // 2026-02-29 does not exist
    expect(resolveAsAt({ kind: 'day', day: 29, month: 2, year: null }, '2028-11-13')?.date).toBe('2028-02-29');
    expect(resolveAsAt({ kind: 'day', day: 29, month: 2, year: null }, '2028-01-10')).toBeNull(); // latest is 2027-02-29: not a day
    expect(resolveAsAt({ kind: 'day', day: 29, month: 2, year: 2026 }, '2026-11-13')).toBeNull();
    expect(resolveAsAt({ kind: 'day', day: 29, month: 2, year: 2028 }, '2028-11-13')?.date).toBe('2028-02-29');
    expect(resolveAsAt({ kind: 'day', day: 30, month: 2, year: null }, '2026-11-13')).toBeNull();
    expect(resolveAsAt({ kind: 'day', day: 15, month: 12, year: null }, '2026-11-13')?.date).toBe('2025-12-15');
  });
  it('the refusal names the day and the year and asks for the year', () => {
    expect(missingDayNote({ kind: 'day', day: 29, month: 2, year: null }, '2026-11-13')).toBe("29 February 2026 doesn't exist. Name the year you mean.");
    expect(missingDayNote({ kind: 'day', day: 15, month: 10, year: null }, '2026-11-13')).toBeNull();
    expect(missingDayNote({ kind: 'month', month: 2, year: null }, '2026-11-13')).toBeNull();
  });
  it('as-at honours the exact day; a day without a year is the latest one not after today; the future is refused', () => {
    expect(resolveAsAt({ kind: 'day', day: 15, month: 10, year: null }, '2026-11-13')?.date).toBe('2026-10-15');
    expect(resolveAsAt({ kind: 'day', day: 15, month: 12, year: null }, '2026-11-13')?.date).toBe('2025-12-15');
    expect(resolveAsAt({ kind: 'day', day: 15, month: 10, year: 2027 }, '2026-11-13')).toBeNull();
    expect(resolveWindow({ kind: 'day', day: 15, month: 10, year: null }, '2026-11-13', null)).toBeNull();
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
