/**
 * Annotations are INTERNAL. This suite is the structural guard on that.
 *
 * It does not read source text — it drives buildSharedPack with a mocked `sql`
 * and inspects the queries it actually issued and the object it actually
 * returned. Add a `loadAnnotations` call to sharedPackService and the first
 * test goes red on the captured query; leak a note into the returned shape and
 * the second does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));

vi.mock('@/modules/accounting/services/gl/financialFiguresService', () => ({
  getFinancialFigures: () => Promise.resolve(FIGURES),
  unclassifiedWarning: () => null,
  totalEquity: () => 300,
}));
vi.mock('@/modules/accounting/services/reports/reportPackService', () => ({
  buildReportPack: () => PACK,
}));

import { buildSharedPack } from '@/modules/accounting/services/share/sharedPackService';
import type { ResolvedShareLink } from '@/modules/accounting/services/share/shareResolver';

const COMPANY = '11111111-1111-4111-8111-111111111111';

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

/**
 * POPULATED on purpose. An empty `sections: []` would let the key-walk below
 * pass without ever descending into a section, so the deep guard would be
 * asserting over three top-level keys and proving nothing about the shape the
 * viewer actually receives. Every section here carries rows with ids, which is
 * exactly where a note would ride along if one were ever attached.
 */
const PACK = {
  type: 'board',
  companyName: 'Acme',
  period: '2026-01-01 to 2026-03-31',
  generatedAt: '2026-04-01T00:00:00.000Z',
  sections: [
    {
      type: 'income_statement',
      title: 'Income Statement',
      data: {
        rows: [
          { id: 'acc:4000', label: 'Sales', actual: 100 },
          { id: 'total:grossProfit', label: 'Gross profit', actual: 60 },
        ],
        revenue: 100, costOfSales: 40, grossProfit: 60, netProfit: 40,
      },
    },
    {
      type: 'balance_sheet',
      title: 'Balance Sheet',
      data: {
        rows: [{ id: 'acc:1000', label: 'Bank', actual: 60 }],
        totalAssets: 500, totalLiabilities: 200, totalEquity: 300,
      },
    },
    { type: 'commentary', title: 'Commentary', data: { rows: [] } },
  ],
};

const LINK: ResolvedShareLink = {
  id: '33333333-3333-4333-8333-333333333333',
  companyId: COMPANY,
  params: { type: 'board', from: '2026-01-01', to: '2026-03-31' },
};

/** Walks the whole returned object, not just its top level: a note buried in a
 *  pack section is as much a leak as one on the root. */
function everyKey(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap(v => everyKey(v, seen));
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => [k, ...everyKey(v, seen)]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('FROM companies')) return Promise.resolve([{ name: 'Acme' }]);
    return Promise.resolve([]);
  });
});

describe('the share path and annotations', () => {
  it('issues no query against report_annotations', async () => {
    await buildSharedPack(LINK);

    expect(sqlMock).toHaveBeenCalled();
    for (const call of sqlMock.mock.calls) {
      expect((call[0] as TemplateStringsArray).join('')).not.toContain('report_annotations');
    }
  });

  it('returns no note, annotation or resolved field anywhere in the shared props', async () => {
    const shared = await buildSharedPack(LINK);

    const keys = everyKey(shared);
    // The walk must actually have descended into the pack. Without this, an
    // empty pack would make the filter below vacuously true.
    expect(keys).toContain('sections');
    expect(keys).toContain('rows');
    expect(keys).toContain('id');
    expect(keys.filter(k => /note|annotation|resolved/i.test(k))).toEqual([]);
  });
});
