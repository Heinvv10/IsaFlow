import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  ar: vi.fn(), ap: vi.fn(), bank: vi.fn(), cash: vi.fn(), income: vi.fn(), sheet: vi.fn(), vat: vi.fn(), emp: vi.fn(), fy: vi.fn(), cycle: vi.fn(), run: vi.fn(), fyLabel: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({ getARAging: m.ar }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAging: m.ap }));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({ getBankAccountsStatus: m.bank }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: m.cash }));
vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({ getIncomeStatement: m.income }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ getBalanceSheet: m.sheet }));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: m.vat }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({ generateEMP201: m.emp }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: m.fy, getFiscalYear: m.fyLabel }));
vi.mock('@/modules/accounting/services/reports/companyVatCycle', () => ({ getCompanyVatCycle: m.cycle }));
vi.mock('@/modules/accounting/services/payroll/payrollRunQueryService', () => ({ getDeclarablePayRun: m.run }));

import { answerQuestion } from '@/modules/accounting/services/ask/askAnswer';
import { parseQuestion } from '@/modules/accounting/services/ask/askIntents';
import { periodIsHonoured } from '@/modules/accounting/services/ask/askPeriod';

const CO = '11111111-1111-1111-1111-111111111111';
const TODAY = '2026-11-13';
const ask = (q: string, co = CO) => answerQuestion(co, q, TODAY);
const aged = [{ entityId: 'a', entityName: 'Acme', total: 1000.5 }, { entityId: 'b', entityName: 'Bolt', total: 250.25 },
  { entityId: 'c', entityName: 'Cog', total: 5000 }, { entityId: 'd', entityName: 'Dyn', total: 20 }, { entityId: 'e', entityName: 'Eve', total: 0 }];
const bankRows = [
  { accountName: 'Cheque', balance: 5000.1, unallocatedCount: 3, isActive: true },
  { accountName: 'Savings', balance: 200.2, unallocatedCount: 4, isActive: true },
  { accountName: 'Old', balance: 999, unallocatedCount: 50, isActive: false },
];
const run = { id: 'run1', periodYear: 2026, periodMonth: 10, status: 'paid', totalGross: 50000, totalNet: 40000, totalPaye: 6000 };

beforeEach(() => {
  vi.clearAllMocks();
  m.ar.mockResolvedValue(aged);
  m.ap.mockResolvedValue([{ entityId: 's', entityName: 'Sup', total: 77.7 }]);
  m.bank.mockResolvedValue(bankRows);
  m.cash.mockResolvedValue({ total: 123.45 });
  m.income.mockResolvedValue({ totalRevenue: 900, totalOtherIncome: 10, totalCostOfSales: 300, totalOperatingExpenses: 200, totalOtherExpenses: 50, netProfit: 360 });
  m.sheet.mockResolvedValue({ totalAssets: 12345.67, totalLiabilities: 2345.01 });
  m.vat.mockResolvedValue({ totals: { outputTax: 150, inputTax: 60, netVat: 90 } });
  m.emp.mockResolvedValue({ payePayable: 1000, totalUIF: 100, totalSDL: 50, totalDeductions: 1150.07 });
  m.fyLabel.mockResolvedValue({ startDate: '2025-03-01', endDate: '2026-02-28' });
  m.fy.mockImplementation(async (_c: string, d: string) => (d >= '2026-03-01' ? { startDate: '2026-03-01', endDate: '2027-02-28' } : { startDate: '2025-03-01', endDate: '2026-02-28' }));
  m.cycle.mockResolvedValue({ cadence: 'bi-monthly', alignment: 'even' });
  m.run.mockResolvedValue(run);
});

describe('figure equals the service figure, with the exact page link', () => {
  const cases: Array<[string, number, string]> = [
    ['who owes me money', 6270.75, '/accounting/ar-aging'],
    ['who do I owe', 77.7, '/accounting/ap-aging'],
    ['how much cash is in the bank', 5200.3, '/accounting/bank-accounts'],
    ['how many bank transactions need allocating', 7, '/accounting/bank-transactions'],
    ['what is my profit this month', 360, '/accounting/reports/income-statement?period_start=2026-11-01&period_end=2026-11-13'],
    ['what is my revenue this year', 900, '/accounting/reports/income-statement?period_start=2026-03-01&period_end=2026-11-13'],
    ['what are my expenses last month', 550, '/accounting/reports/income-statement?period_start=2026-10-01&period_end=2026-10-31'],
    ['total assets', 12345.67, '/accounting/reports/balance-sheet'],
    ['total liabilities', 2345.01, '/accounting/reports/balance-sheet'],
    ['what vat do I owe', 90, '/accounting/sars/vat201?from=2026-11-01&to=2026-12-31'],
    ['what do I owe sars for payroll', 1150.07, '/accounting/sars/emp201?from=2026-10-01&to=2026-10-31'],
    ['what did the last pay run cost', 50000, '/payroll/runs/run1'],
  ];
  it.each(cases)('%s -> %d', async (q, figure, href) => {
    const a = await ask(q);
    expect(a.understood).toBe(true);
    expect(a.figure).toBe(figure);
    expect(a.link?.href).toBe(href);
  });
});

describe('company scoping', () => {
  it('every service call receives the session company, and another id reaches the service as that id', async () => {
    for (const q of ['who owes me money', 'who do I owe', 'cash in the bank', 'profit this month', 'total assets', 'vat', 'sars payroll', 'last pay run cost']) await ask(q);
    for (const fn of [m.ar, m.ap, m.bank, m.cash, m.income, m.sheet, m.vat, m.emp]) {
      expect(fn.mock.calls.length).toBeGreaterThan(0);
      for (const c of fn.mock.calls) expect(c[0]).toBe(CO);
    }
    for (const fn of [m.cycle, m.run]) for (const c of fn.mock.calls) expect(c[0]).toBe(CO);
    await ask('who owes me money', 'other-co');
    expect(m.ar).toHaveBeenLastCalledWith('other-co', TODAY);
  });
});

describe('lines', () => {
  it('aging lists the top three by size, largest first, without zero rows', async () => {
    expect((await ask('who owes me money')).lines).toEqual([
      { label: 'Cog', value: 5000 }, { label: 'Acme', value: 1000.5 }, { label: 'Bolt', value: 250.25 }]);
  });
  it('bank: headline is the active accounts; inactive listed apart; ledger cash shown', async () => {
    const a = await ask('how much cash is in the bank');
    expect(a.figure).toBe(5200.3);
    expect(a.lines).toEqual([
      { label: 'Cheque', value: 5000.1 }, { label: 'Savings', value: 200.2 },
      { label: 'Old (inactive, not in the total)', value: 999 }, { label: 'Ledger cash (general ledger)', value: 123.45 }]);
    expect(a.text).toContain('R 123.45');
    expect(m.cash).toHaveBeenCalledWith(CO, TODAY);
  });
  it('bank to allocate counts active accounts only', async () => {
    expect((await ask('how many bank transactions need allocating')).figure).toBe(7);
  });
  it('profit lines reconcile: revenue + other income - the three expense lines = profit', async () => {
    const a = await ask('what is my profit this month');
    const v = Object.fromEntries(a.lines.map((l) => [l.label, l.value]));
    expect(v['Revenue']! + v['Other income']! - v['Cost of sales']! - v['Operating expenses']! - v['Other expenses (finance cost, tax)']!).toBe(a.figure);
  });
  it('expenses include other expenses', async () => {
    const a = await ask('what are my expenses this month');
    expect(a.figure).toBe(550);
    expect(a.lines.map((l) => l.value)).toEqual([300, 200, 50]);
  });
  it('vat lines are output then input; emp201 lines are PAYE, UIF, SDL', async () => {
    expect((await ask('vat')).lines).toEqual([{ label: 'Output tax', value: 150 }, { label: 'Input tax', value: 60 }]);
    expect((await ask('emp201')).lines).toEqual([{ label: 'PAYE payable', value: 1000 }, { label: 'UIF', value: 100 }, { label: 'SDL', value: 50 }]);
  });
  it('every service is asked for exactly the window the question names', async () => {
    await ask('what do I owe sars for payroll');
    expect(m.emp).toHaveBeenLastCalledWith(CO, '2026-10-01', '2026-10-31');
    await ask('emp201 for february');
    expect(m.emp).toHaveBeenLastCalledWith(CO, '2026-02-01', '2026-02-28');
    await ask('what is my profit last month');
    expect(m.income).toHaveBeenLastCalledWith(CO, '2026-10-01', '2026-10-31');
    await ask('what are my total assets');
    expect(m.sheet).toHaveBeenLastCalledWith(CO, TODAY);
    await ask('what are my total assets last month');
    expect(m.sheet).toHaveBeenLastCalledWith(CO, '2026-10-31');
    await ask('what vat do I owe for august');
    expect(m.vat).toHaveBeenLastCalledWith(CO, '2026-07-01', '2026-08-31', expect.anything());
    await ask('who do I owe last month');
    expect(m.ap).toHaveBeenLastCalledWith(CO, '2026-10-31');
  });
  it('emp201 reads the service total, not a recomputation', async () => {
    expect((await ask('emp201')).figure).toBe(1150.07);
  });
});

describe('VAT period', () => {
  it('no period named: the company\'s current VAT period, and no "period you named" wording', async () => {
    const a = await ask('what vat do I owe');
    expect(m.vat).toHaveBeenCalledWith(CO, '2026-11-01', '2026-12-31', expect.anything());
    expect(a.text).toContain('This is your current VAT period (2026-11-01\u20132026-12-31).');
    expect(a.text).not.toContain('you named');
  });
  it('a named month maps to the VAT period holding it and says so', async () => {
    const a = await ask('what vat do I owe for october');
    expect(m.vat).toHaveBeenCalledWith(CO, '2026-09-01', '2026-10-31', expect.anything());
    expect(a.text).toContain('October 2026 falls in this VAT period');
    expect(a.link?.href).toBe('/accounting/sars/vat201?from=2026-09-01&to=2026-10-31');
  });
  it('a monthly filer gets that month', async () => {
    m.cycle.mockResolvedValue({ cadence: 'monthly', alignment: 'odd' });
    await ask('what vat do I owe for october');
    expect(m.vat).toHaveBeenCalledWith(CO, '2026-10-01', '2026-10-31', expect.anything());
  });
  it('a non-vendor is told there is no VAT201', async () => {
    m.cycle.mockResolvedValue(null);
    const a = await ask('vat');
    expect(a.figure).toBeNull();
    expect(a.text).toContain('not set up as a VAT vendor');
    expect(m.vat).not.toHaveBeenCalled();
  });
});

describe('VAT wording for the current period', () => {
  it.each([['vat payable this period'], ['vat for the current period'], ['what vat do I owe this month'], ['how much vat do we owe']])('%s says it is the current VAT period', async (q) => {
    const a = await ask(q);
    expect(a.text).toContain('This is your current VAT period (2026-11-01\u20132026-12-31).');
    expect(a.text).not.toContain('falls in this VAT period');
  });
  it('a named month still says which month falls in the period', async () => {
    expect((await ask('what vat do I owe for october')).text).toContain('October 2026 falls in this VAT period');
  });
});

describe('pay run', () => {
  it('the latest run overall when no month is named; a named month asks for that month', async () => {
    await ask('what did the last pay run cost');
    expect(m.run).toHaveBeenLastCalledWith(CO, null);
    await ask('what did payroll cost last month');
    expect(m.run).toHaveBeenLastCalledWith(CO, { year: 2026, month: 10 });
  });
  it('none found is said, not invented', async () => {
    m.run.mockResolvedValue(null);
    const a = await ask('what did payroll cost last month');
    expect(a.figure).toBeNull();
    expect(a.text).toContain('October 2026');
  });
});

describe('windows it cannot honour are said, never replaced by a default', () => {
  it.each([
    ['what is my profit for 2025'], ['vat for last year'], ['emp201 this year'], ['who owes me money last year'],
    ['total assets last quarter'], ['cash in the bank last month'], ['last pay run cost this year'],
  ])('%s', async (q) => {
    const a = await ask(q);
    expect(a.figure).toBeNull();
    expect(a.text).toMatch(/can't answer/);
    for (const fn of [m.ar, m.income, m.sheet, m.vat, m.emp, m.bank, m.run]) expect(fn).not.toHaveBeenCalled();
  });
  it('aging and balance sheet honour a month as at its end, and say the date', async () => {
    const a = await ask('who owes me money last month');
    expect(m.ar).toHaveBeenCalledWith(CO, '2026-10-31');
    expect(a.text).toContain('2026-10-31');
    await ask('total assets for september');
    expect(m.sheet).toHaveBeenCalledWith(CO, '2026-09-30');
  });
  it('last year is the previous financial year from the registry', async () => {
    await ask('what is my profit last year');
    expect(m.income).toHaveBeenCalledWith(CO, '2025-03-01', '2026-02-28');
  });
});

describe('narrower figures and wording', () => {
  it('gross profit is gross profit, labelled, never net profit', async () => {
    m.income.mockResolvedValue({ totalRevenue: 900, totalOtherIncome: 10, totalCostOfSales: 300, totalOperatingExpenses: 200, totalOtherExpenses: 50, netProfit: 360, grossProfit: 600, operatingProfit: 410 });
    const a = await ask('what is my gross profit this month');
    expect(a.figure).toBe(600);
    expect(a.text).toMatch(/^Gross profit/);
    expect(a.text).not.toMatch(/Net profit/);
    expect((await ask('operating profit last month')).figure).toBe(410);
  });
  it('cost of sales is answered as cost of sales and is not ambiguous', async () => {
    const a = await ask('cost of sales last month');
    expect(a.understood).toBe(true);
    expect(a.figure).toBe(300);
    expect(a.text).toMatch(/^Cost of sales/);
  });
  it('"what can I spend" is not an expenses question', async () => {
    const a = await ask('what can I spend?');
    expect(a.understood).toBe(false);
    expect(m.income).not.toHaveBeenCalled();
  });
  it('bank: this month, today are the current balance; a past period is refused in the person\'s words', async () => {
    expect((await ask('cash in the bank this month')).figure).toBe(5200.3);
    expect((await ask('cash in the bank today')).figure).toBe(5200.3);
    const a = await ask('cash in the bank last month');
    expect(a.figure).toBeNull();
    expect(a.text).toContain('"last month"');
    expect((await ask('cash in the bank in october')).text).toContain('"October"');
  });
  it('profit in a quarter or half is refused, not answered with the default month', async () => {
    for (const q of ['profit in Q3', 'profit first quarter', 'profit H1', 'profit for the half year']) {
      expect((await ask(q)).figure, q).toBeNull();
    }
    expect(m.income).not.toHaveBeenCalled();
  });
});

describe('the pre-charge window check agrees with the answers', () => {
  it.each([
    ['profit'], ['revenue'], ['expenses'], ['total assets'], ['total liabilities'],
  ])('%s: refused exactly when periodIsHonoured says so', async (word) => {
    for (const when of ['', 'this month', 'last month', 'in october', 'this year', 'last year', 'for 2025', 'in q3', 'last quarter', 'today']) {
      const q = `what are my ${word} ${when}`.trim();
      const parsed = parseQuestion(q);
      if (parsed.kind !== 'intent') throw new Error(`${q} did not parse to one intent`);
      const a = await ask(q);
      expect(a.figure === null, q).toBe(!periodIsHonoured(parsed.intent.id, parsed.intent.period, TODAY));
    }
  });
});

describe('exact days', () => {
  it('aging and the balance sheet are as at that exact day, and the text says it', async () => {
    const a = await ask('who owes me money as at 15 october');
    expect(m.ar).toHaveBeenLastCalledWith(CO, '2026-10-15');
    expect(a.text).toContain('2026-10-15');
    await ask('total assets as at 15 october');
    expect(m.sheet).toHaveBeenLastCalledWith(CO, '2026-10-15');
    await ask('who do I owe as at 3 march 2026');
    expect(m.ap).toHaveBeenLastCalledWith(CO, '2026-03-03');
  });
  it('a day is never rounded: figures that are not positions refuse it', async () => {
    for (const q of ['profit on 15 october', 'what vat do I owe on 15 october', 'emp201 on 15 october', 'last pay run cost on 15 october', 'cash in the bank on 15 october']) {
      const a = await ask(q);
      expect(a.figure, q).toBeNull();
      expect(a.text, q).toMatch(/can't answer/);
    }
    for (const fn of [m.income, m.vat, m.emp, m.run, m.bank]) expect(fn).not.toHaveBeenCalled();
  });
  it('29 February in a non-leap year is refused before any service call; in a leap year it is honoured', async () => {
    const a = await ask('total assets as at 29 february 2026');
    expect(a.figure).toBeNull();
    expect(m.sheet).not.toHaveBeenCalled();
    await ask('total assets as at 29 february 2024');
    expect(m.sheet).toHaveBeenLastCalledWith(CO, '2024-02-29');
  });
  it('a day in the future is refused for a position', async () => {
    const a = await ask('total assets as at 15 october 2027');
    expect(a.figure).toBeNull();
    expect(m.sheet).not.toHaveBeenCalled();
  });
});

describe('refinements we cannot honour are said, never answered with the broader figure', () => {
  it.each([['who owes me more than 2000'], ['net profit vs last month'], ['profit before tax'], ['profit this year vs last year']])('%s', async (q) => {
    const a = await ask(q);
    expect(a.understood).toBe(false);
    expect(a.figure).toBeNull();
    expect(a.suggestions.length).toBeGreaterThan(0);
    for (const fn of [m.ar, m.income, m.sheet]) expect(fn).not.toHaveBeenCalled();
  });
  it('the reply names what it cannot do', async () => {
    expect((await ask('who owes me more than 2000')).text).toContain('amount filters');
    expect((await ask('net profit vs last month')).text).toContain('comparisons');
    expect((await ask('profit before tax')).text).toContain('before or after tax');
    expect((await ask('profit this year vs last year')).text).toContain('one period at a time');
  });
  it('a comma inside a clause still answers', async () => {
    expect((await ask('How much cash, roughly, is in the bank?')).figure).toBe(5200.3);
  });
});

describe('unsupported windows are answered with a refusal, not a default', () => {
  it.each([['profit last 30 days'], ['revenue since march'], ['what are my expenses past 3 months'], ['profit next month']])('%s', async (q) => {
    const a = await ask(q);
    expect(a.figure).toBeNull();
    expect(a.text).toMatch(/can't answer/);
    expect(m.income).not.toHaveBeenCalled();
  });
  it('periodIsHonoured is false for a day that resolves to nothing', () => {
    expect(periodIsHonoured('assets', { kind: 'day', day: 29, month: 2, year: 2026 }, TODAY)).toBe(false);
    expect(periodIsHonoured('assets', { kind: 'day', day: 29, month: 2, year: null }, TODAY)).toBe(false);
    expect(periodIsHonoured('assets', { kind: 'day', day: 28, month: 2, year: null }, TODAY)).toBe(true);
    expect(periodIsHonoured('liabilities', { kind: 'day', day: 31, month: 4, year: 2026 }, TODAY)).toBe(false);
  });
  it('excluding VAT is a refusal for revenue, and the plain suggestion is revenue', async () => {
    const a = await ask('revenue excluding vat');
    expect(a.figure).toBeNull();
    expect(a.suggestions).toEqual(['What is my revenue this year?']);
    expect(m.vat).not.toHaveBeenCalled();
  });
});

describe('financial years by label, and leftover words', () => {
  it('profit for FY2026 reads the registry year and asks the income statement for exactly its dates', async () => {
    const a = await ask('profit fy2026');
    expect(m.fyLabel).toHaveBeenCalledWith(CO, 2026);
    expect(m.income).toHaveBeenLastCalledWith(CO, '2025-03-01', '2026-02-28');
    expect(a.text).toContain('FY2026');
    expect(a.link?.href).toBe('/accounting/reports/income-statement?period_start=2025-03-01&period_end=2026-02-28');
  });
  it('an unknown financial year is refused; other intents refuse a financial year label', async () => {
    m.fyLabel.mockResolvedValue(null);
    expect((await ask('profit fy2019')).figure).toBeNull();
    expect(m.income).not.toHaveBeenCalled();
    for (const q of ['total assets fy2026', 'vat fy2026', 'who owes me money fy2026']) expect((await ask(q)).figure, q).toBeNull();
  });
  it('leftover words are refused with the plain question, calling no service', async () => {
    const a = await ask('profit by customer');
    expect(a.understood).toBe(false);
    expect(a.text).toContain('"by"');
    expect(a.suggestions).toEqual(['What is my profit this month?']);
    for (const fn of [m.income, m.ar, m.vat, m.sheet]) expect(fn).not.toHaveBeenCalled();
  });
  it('a yearless 29 February is refused naming the year, not answered as another year', async () => {
    const a = await ask('who owes me money as at 29 february');
    expect(a.figure).toBeNull();
    expect(a.text).toBe("29 February 2026 doesn't exist. Name the year you mean.");
    expect(m.ar).not.toHaveBeenCalled();
  });
});

describe('unrecognised and ambiguous', () => {
  it('an unrecognised question calls nothing and suggests the twelve', async () => {
    const a = await ask('what is the weather');
    expect(a.understood).toBe(false);
    expect(a.suggestions).toHaveLength(12);
    for (const fn of [m.ar, m.ap, m.bank, m.income, m.sheet, m.vat, m.emp, m.cycle, m.run]) expect(fn).not.toHaveBeenCalled();
  });
  it('an ambiguous question asks which was meant, offering exactly those intents', async () => {
    const a = await ask('who owes me VAT?');
    expect(a.understood).toBe(false);
    expect(a.text).toMatch(/Which did you mean/);
    expect(a.suggestions).toEqual(['Who owes me money?', 'What VAT do I owe for October?']);
    for (const fn of [m.ar, m.vat, m.cycle]) expect(fn).not.toHaveBeenCalled();
  });
  it('"vat and profit" asks which, and answers neither', async () => {
    const a = await ask('vat and profit');
    expect(a.understood).toBe(false);
    expect(a.suggestions).toHaveLength(2);
    expect(m.vat).not.toHaveBeenCalled();
    expect(m.income).not.toHaveBeenCalled();
  });
});
