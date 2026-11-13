import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  ar: vi.fn(), ap: vi.fn(), bank: vi.fn(), cash: vi.fn(), income: vi.fn(), sheet: vi.fn(), vat: vi.fn(), emp: vi.fn(), fy: vi.fn(), sql: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({ getARAging: m.ar }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAging: m.ap }));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({ getBankAccountsStatus: m.bank }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: m.cash }));
vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({ getIncomeStatement: m.income }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ getBalanceSheet: m.sheet }));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: m.vat }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({ generateEMP201: m.emp }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: m.fy }));
vi.mock('@/lib/neon', () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => m.sql(s.join('?'), v) }));

import { answerQuestion } from '@/modules/accounting/services/ask/askAnswer';

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
const run = { id: 'run1', company_id: CO, period_year: 2026, period_month: 10, status: 'paid', total_gross: 50000, total_net: 40000, total_paye: 6000 };

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
  m.fy.mockImplementation(async (_c: string, d: string) => (d >= '2026-03-01' ? { startDate: '2026-03-01', endDate: '2027-02-28' } : { startDate: '2025-03-01', endDate: '2026-02-28' }));
  m.sql.mockImplementation(async (text: string) => (text.includes('FROM companies') ? [{ vat_period: 'bi-monthly', vat_system_type: 'invoice', vat_period_alignment: 'even' }] : [run]));
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
    for (const c of m.sql.mock.calls) expect(JSON.stringify(c[1])).toContain(CO);
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
  it('emp201 reads the service total, not a recomputation', async () => {
    expect((await ask('emp201')).figure).toBe(1150.07);
  });
});

describe('VAT period', () => {
  it('no period named: the company\'s current VAT period, and no "period you named" wording', async () => {
    const a = await ask('what vat do I owe');
    expect(m.vat).toHaveBeenCalledWith(CO, '2026-11-01', '2026-12-31', expect.anything());
    expect(a.text).toContain('current VAT period');
    expect(a.text).not.toContain('you named');
  });
  it('a named month maps to the VAT period holding it and says so', async () => {
    const a = await ask('what vat do I owe for october');
    expect(m.vat).toHaveBeenCalledWith(CO, '2026-09-01', '2026-10-31', expect.anything());
    expect(a.text).toContain('October 2026 falls in this VAT period');
    expect(a.link?.href).toBe('/accounting/sars/vat201?from=2026-09-01&to=2026-10-31');
  });
  it('a monthly filer gets that month', async () => {
    m.sql.mockImplementation(async (t: string) => (t.includes('FROM companies') ? [{ vat_period: 'monthly', vat_system_type: 'invoice', vat_period_alignment: 'odd' }] : [run]));
    await ask('what vat do I owe for october');
    expect(m.vat).toHaveBeenCalledWith(CO, '2026-10-01', '2026-10-31', expect.anything());
  });
  it('a non-vendor is told there is no VAT201', async () => {
    m.sql.mockImplementation(async () => [{ vat_period: 'none', vat_system_type: 'none', vat_period_alignment: null }]);
    const a = await ask('vat');
    expect(a.figure).toBeNull();
    expect(a.text).toContain('not set up as a VAT vendor');
    expect(m.vat).not.toHaveBeenCalled();
  });
});

describe('pay run', () => {
  const sqlOf = (): { text: string; values: unknown[] } => {
    const c = m.sql.mock.calls.find((x) => String(x[0]).includes('payroll_run_headers'))!;
    return { text: String(c[0]), values: c[1] as unknown[] };
  };
  it('only declarable statuses, ties broken by creation time', async () => {
    await ask('what did the last pay run cost');
    const { text, values } = sqlOf();
    expect(values).toContainEqual(['approved', 'paid']);
    expect(text).toMatch(/ORDER BY period_year DESC, period_month DESC, created_at DESC/);
  });
  it('a named month asks for that month; none found is said, not invented', async () => {
    m.sql.mockImplementation(async () => []);
    const a = await ask('what did payroll cost last month');
    expect(sqlOf().values).toEqual(expect.arrayContaining([2026, 10]));
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
    for (const fn of [m.ar, m.income, m.sheet, m.vat, m.emp, m.bank]) expect(fn).not.toHaveBeenCalled();
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

describe('unrecognised and ambiguous', () => {
  it('an unrecognised question calls nothing and suggests the twelve', async () => {
    const a = await ask('what is the weather');
    expect(a.understood).toBe(false);
    expect(a.suggestions).toHaveLength(12);
    for (const fn of [m.ar, m.ap, m.bank, m.income, m.sheet, m.vat, m.emp, m.sql]) expect(fn).not.toHaveBeenCalled();
  });
  it('an ambiguous question asks which was meant, offering exactly those intents', async () => {
    const a = await ask('who owes me VAT?');
    expect(a.understood).toBe(false);
    expect(a.text).toMatch(/Which did you mean/);
    expect(a.suggestions).toEqual(['Who owes me money?', 'What VAT do I owe for October?']);
    for (const fn of [m.ar, m.vat, m.sql]) expect(fn).not.toHaveBeenCalled();
  });
});
