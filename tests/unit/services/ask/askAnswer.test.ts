import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  ar: vi.fn(), ap: vi.fn(), bank: vi.fn(), figures: vi.fn(), sheet: vi.fn(), vat: vi.fn(), emp: vi.fn(), runs: vi.fn(), fy: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({ getARAging: m.ar }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAging: m.ap }));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({ getBankAccountsStatus: m.bank }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', () => ({ getFinancialFigures: m.figures }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ getBalanceSheet: m.sheet }));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: m.vat }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({ generateEMP201: m.emp }));
vi.mock('@/modules/accounting/services/payroll/payrollRunQueryService', () => ({ listPayRunsPage: m.runs }));
vi.mock('@/modules/accounting/services/gl/fiscalYearBasis', () => ({ getFiscalYearStartMonth: m.fy, DEFAULT_FY_START_MONTH: 3 }));

import { answerQuestion } from '@/modules/accounting/services/ask/askAnswer';
import { rand } from '@/modules/accounting/services/ask/askTypes';

const CO = '11111111-1111-1111-1111-111111111111';
const TODAY = '2026-11-13';
const book = [{ entityId: 'a', entityName: 'Acme', total: 1000.5 }, { entityId: 'b', entityName: 'Bolt', total: 250.25 }];

beforeEach(() => {
  vi.clearAllMocks();
  m.ar.mockResolvedValue(book);
  m.ap.mockResolvedValue([{ entityId: 's', entityName: 'Sup', total: 77.7 }]);
  m.bank.mockResolvedValue([
    { accountName: 'Cheque', balance: 5000.1, unallocatedCount: 3 }, { accountName: 'Savings', balance: 200.2, unallocatedCount: 4 },
  ]);
  m.figures.mockResolvedValue({ period: { revenue: 900, costOfSales: 300, operatingExpenses: 200, netProfit: 400 } });
  m.sheet.mockResolvedValue({ totalAssets: 12345.67, totalLiabilities: 2345.01 });
  m.vat.mockResolvedValue({ totals: { outputTax: 150, inputTax: 60, netVat: 90 } });
  m.emp.mockResolvedValue({ payePayable: 1000, totalUIF: 100, totalSDL: 50 });
  m.runs.mockResolvedValue({ rows: [{ id: 'run1', periodYear: 2026, periodMonth: 10, status: 'paid', totalGross: 50000, totalNet: 40000, totalPaye: 6000 }] });
  m.fy.mockResolvedValue(3);
});

describe('answerQuestion: figure equals the service figure', () => {
  const cases: Array<[string, number, () => unknown]> = [
    ['who owes me money', 1250.75, () => m.ar],
    ['who do I owe', 77.7, () => m.ap],
    ['how much cash is in the bank', 5200.3, () => m.bank],
    ['how many bank transactions need allocating', 7, () => m.bank],
    ['what is my profit this month', 400, () => m.figures],
    ['what is my revenue this year', 900, () => m.figures],
    ['what are my expenses last month', 500, () => m.figures],
    ['total assets', 12345.67, () => m.sheet],
    ['total liabilities', 2345.01, () => m.sheet],
    ['what vat do I owe for october', 90, () => m.vat],
    ['what do I owe sars for payroll', 1150, () => m.emp],
    ['what did the last pay run cost', 50000, () => m.runs],
  ];
  it.each(cases)('%s -> %d', async (q, figure, svc) => {
    const a = await answerQuestion(CO, q, TODAY);
    expect(a.understood).toBe(true);
    expect(a.figure).toBe(figure);
    expect(a.link?.href).toMatch(/^\//);
    expect(svc()).toHaveBeenCalled();
  });

  it('scopes every service call to the session company', async () => {
    for (const [q, , svc] of cases) {
      await answerQuestion(CO, q, TODAY);
      for (const call of (svc() as ReturnType<typeof vi.fn>).mock.calls) expect(call[0]).toBe(CO);
    }
  });

  it('never answers from another company: a different id reaches the service as that id', async () => {
    await answerQuestion('other-co', 'who owes me money', TODAY);
    expect(m.ar).toHaveBeenLastCalledWith('other-co', TODAY);
    expect(m.ar).not.toHaveBeenCalledWith(CO, TODAY);
  });

  it('asks the VAT service for the month named', async () => {
    await answerQuestion(CO, 'what vat do I owe for october', TODAY);
    expect(m.vat).toHaveBeenCalledWith(CO, '2026-10-01', '2026-10-31', expect.anything());
  });
});

describe('answerQuestion: edges', () => {
  it('an unrecognised question calls no service and suggests the twelve', async () => {
    const a = await answerQuestion(CO, 'what is the weather', TODAY);
    expect(a.understood).toBe(false);
    expect(a.suggestions).toHaveLength(12);
    for (const fn of Object.values(m)) expect(fn).not.toHaveBeenCalled();
  });
  it('no pay runs is said, not invented', async () => {
    m.runs.mockResolvedValue({ rows: [] });
    const a = await answerQuestion(CO, 'last pay run cost', TODAY);
    expect(a.figure).toBeNull();
    expect(a.text).toMatch(/no pay runs/i);
  });
  it('formats rand with space thousands and a sign', () => {
    expect(rand(1234567.891)).toBe('R 1 234 567.89');
    expect(rand(-5)).toBe('-R 5.00');
  });
});
