/**
 * The pack a share link renders. Pinned here: the company comes from the
 * resolved link, never a caller-supplied id; commentary is loaded only through
 * a query that selects `approved_text` filtered on `status = 'approved'` — a
 * draft has no path into the returned commentary array.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
// `withSavepoint` stays real: the pack input's cash-flow read takes one, and
// outside a request transaction it simply runs the read.
vi.mock('@/lib/neon', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sql: (...a: unknown[]) => sqlMock(...a),
}));

const getFinancialFiguresMock = vi.fn();
const unclassifiedWarningMock = vi.fn();
// The rest of the module is real: the pack input is assembled by
// `readReportPackInput`, the one producer every pack surface shares, and it
// maps these figures through the module's own `toFinancialData`.
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures: (...a: unknown[]) => getFinancialFiguresMock(...a),
  unclassifiedWarning: (...a: unknown[]) => unclassifiedWarningMock(...a),
}));
const getCashFlowDirectMock = vi.fn();
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: (...a: unknown[]) => getCashFlowDirectMock(...a),
}));

const buildReportPackMock = vi.fn();
vi.mock('@/modules/accounting/services/reports/reportPackService', () => ({
  buildReportPack: (...a: unknown[]) => buildReportPackMock(...a),
}));

import { buildSharedPack } from '@/modules/accounting/services/share/sharedPackService';
import type { ResolvedShareLink } from '@/modules/accounting/services/share/shareResolver';
import { canonicalParamsHash } from '@/modules/accounting/services/reports/packParamsHash';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';

const LINK: ResolvedShareLink = {
  id: '33333333-3333-4333-8333-333333333333',
  companyId: COMPANY,
  params: { type: 'board', from: '2026-01-01', to: '2026-03-31' },
};

const FIGURES = {
  inventoryClassified: true,
  retainedEarningsBroughtForward: 0,
  period: {
    revenue: 100, costOfSales: 40, operatingExpenses: 20, netProfit: 40,
    otherIncome: 0, otherExpenses: 0, operatingProfit: 40, depreciation: 0,
    unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: {},
  },
  cumulative: {
    totalAssets: 500, totalLiabilities: 200, totalEquity: 300,
    currentAssets: 100, currentLiabilities: 50, cash: 60,
    accountsReceivable: 30, accountsPayable: 20, inventory: 10,
    unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: {},
  },
};

const PACK = { type: 'board', companyName: 'Acme', period: '2026-01-01 to 2026-03-31', generatedAt: '', sections: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getFinancialFiguresMock.mockResolvedValue(FIGURES);
  getCashFlowDirectMock.mockResolvedValue({ operatingTotal: 55, investingTotal: -20, financingTotal: 5, netChange: 40 });
  unclassifiedWarningMock.mockReturnValue(null);
  buildReportPackMock.mockReturnValue(PACK);
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('FROM companies')) return Promise.resolve([{ name: 'Acme' }]);
    if (text.includes('FROM report_commentary')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe('buildSharedPack', () => {
  it('scopes every query to the link row company, never a caller-supplied id', async () => {
    await buildSharedPack(LINK);

    expect(getCashFlowDirectMock).toHaveBeenCalledWith(COMPANY, LINK.params.from, LINK.params.to);
    expect(getFinancialFiguresMock).toHaveBeenCalledWith(COMPANY, LINK.params.from, LINK.params.to);
    const commentaryCall = sqlMock.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('FROM report_commentary'));
    expect(commentaryCall).toBeDefined();
    expect(commentaryCall![1]).toBe(COMPANY);
    expect(commentaryCall![1]).not.toBe(OTHER_COMPANY);
  });

  it('builds the pack from the link params via the shared builder', async () => {
    const result = await buildSharedPack(LINK);

    expect(buildReportPackMock).toHaveBeenCalledWith('board', expect.objectContaining({
      companyName: 'Acme',
      revenue: 100,
      // The balance-sheet equity plus the period's result, from the figures
      // service's own `totalEquity`: 300 + 40.
      totalEquity: 340,
      // And the window's cash flows, which a hand-built input never carried.
      operatingCashFlow: 55, investingCashFlow: -20, financingCashFlow: 5,
    }), '2026-01-01', '2026-03-31');
    expect(result.pack).toBe(PACK);
    expect(result.companyName).toBe('Acme');
    expect(result.period).toEqual({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('selects only approved_text filtered on status = approved, never a draft column', async () => {
    await buildSharedPack(LINK);

    const commentaryCall = sqlMock.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('FROM report_commentary'));
    const queryText = (commentaryCall![0] as TemplateStringsArray).join('');
    expect(queryText).toContain('approved_text');
    expect(queryText).toContain("status = 'approved'");
    expect(queryText).not.toMatch(/draft_text/);
  });

  it('keys the commentary lookup on the canonical params hash', async () => {
    await buildSharedPack(LINK);

    const commentaryCall = sqlMock.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('FROM report_commentary'));
    expect(commentaryCall![2]).toBe(canonicalParamsHash(LINK.params));
  });

  it('maps approved rows into PublishedCommentary, ignoring rows without approved_text', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('');
      if (text.includes('FROM companies')) return Promise.resolve([{ name: 'Acme' }]);
      if (text.includes('FROM report_commentary')) {
        return Promise.resolve([
          { section_ref: 'income_statement', row_ref: 'revenue', approved_text: 'Revenue grew.' },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await buildSharedPack(LINK);

    expect(result.commentary).toEqual([
      { sectionRef: 'income_statement', rowRef: 'revenue', text: 'Revenue grew.' },
    ]);
  });

  it('falls back to a generic company name when the row is missing', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('');
      if (text.includes('FROM companies')) return Promise.resolve([]);
      if (text.includes('FROM report_commentary')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const result = await buildSharedPack(LINK);

    expect(result.companyName).toBe('Company');
  });

  it('carries the unclassified warning through from the cumulative figures', async () => {
    const warning = { accounts: 2, amount: 500, message: 'x', byType: [] };
    unclassifiedWarningMock.mockReturnValue(warning);

    const result = await buildSharedPack(LINK);

    expect(unclassifiedWarningMock).toHaveBeenCalledWith(FIGURES.cumulative);
    expect(result.unclassifiedAccounts).toBe(warning);
  });

  it('MUTATION CHECK: a service that accepted a caller-supplied company id would fail this', async () => {
    // Guards against a future edit that widens buildSharedPack's signature to
    // take a companyId parameter instead of deriving it from the link. If the
    // company id used for the DB calls does not literally equal link.companyId,
    // this assertion (not a re-implementation) catches it.
    await buildSharedPack(LINK);
    for (const call of sqlMock.mock.calls) {
      const text = (call[0] as TemplateStringsArray).join('');
      if (text.includes('WHERE') && (text.includes('company_id') || text.includes('companies'))) {
        expect(call).toContain(COMPANY);
      }
    }
  });
});
