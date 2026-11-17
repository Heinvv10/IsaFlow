/**
 * readLimitsSize.test.ts's rule for the PR 3 budget reads: at their default and maximum page, with worst realistic
 * content (long codes and labels, the widest amounts, a 15-month year, every optional field filled), the reply stays
 * under MAX_READ_RESULT_BYTES. get_budget_drivers (drivers paged, hires and overrides capped), get_three_way (every
 * section by default, long lists cut at THREE_WAY_LIST_CAP, an assumptions document with long lists),
 * derive_three_way, budget_remaining (200 lines) and budget_tracking (alerts paged).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverWriteService', () => ({ listDrivers: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/plannedHireService', () => ({ listHires: vi.fn(), readHeadcount: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: vi.fn(), deriveView: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetAlertList', async (orig) => ({ ...(await orig<object>()), listBudgetAlerts: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/remainingBudget', async (orig) => ({ ...(await orig<object>()), remainingFor: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/tracking/trackingWindow', async (orig) => ({ ...(await orig<object>()), registryYears: vi.fn() }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { listDrivers } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { listHires, readHeadcount } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import { deriveView, getThreeWay } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { listBudgetAlerts } from '@/modules/accounting/services/budgets/budgetAlertList';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';
import { registryYears } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import { BUCKET_KEYS, PNL_BANDS } from '@/modules/accounting/services/budgets/threeWay/types';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import { DRIVERS_LIMIT_DEFAULT, DRIVERS_LIMIT_MAX, getBudgetDriversTool } from '@/lib/mcp/tools/budgetDriverRead';
import { THREE_WAY_LIST_CAP, deriveThreeWayTool, getThreeWayTool } from '@/lib/mcp/tools/budgetThreeWayTools';
import { ALERTS_LIMIT_DEFAULT, ALERTS_LIMIT_MAX, budgetRemainingTool, budgetTrackingTool } from '@/lib/mcp/tools/budgetControlTools';
import { VERSION, ctx, model, version } from './budgetToolsFixture';

const id = (i: number, tag: string) => `${tag}${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`;
const long = (n: number, tag: string) => `${tag} ${'N'.repeat(n - tag.length - 1)}`;
const WIDE = -99999999999.99;
const CENTS = -999999999999999;
const MONTHS = Array.from({ length: 15 }, (_, i) => `20${26 + Math.floor((i + 2) / 12)}-${String(((i + 2) % 12) + 1).padStart(2, '0')}`);
const bytes = (r: { content: Array<{ text: string }> }) => Buffer.byteLength(r.content[0]!.text, 'utf8');
vi.mocked(getVersion).mockResolvedValue(version({ name: long(120, 'V') }) as never);

describe('get_budget_drivers', () => {
  const accounts = Array.from({ length: 300 }, (_, i) => ({ id: id(i, 'a'), code: long(20, `C${i}`), name: 'x', type: 'expense', band: 'operating_expense', isActive: true, isHeader: false, childIds: [], ownAmounts: false }));
  const cc1 = Array.from({ length: 300 }, (_, i) => ({ id: id(i, 'c'), code: long(20, `M${i}`), name: 'm', isActive: true }));
  const line = (i: number) => ({
    id: id(i, 'd'), updatedAt: '2026-11-16T10:00:00.000001Z', glAccountId: id(i, 'a'), cc1Id: id(i, 'c'), cc2Id: null, buId: null, kind: 'per_head',
    fromMonth: MONTHS[0], toMonth: MONTHS[14], amount: WIDE, pct: null, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: id(i, 'c'), rounding: 1000,
  });
  it.each([['default', {}, DRIVERS_LIMIT_DEFAULT], ['maximum', { limit: DRIVERS_LIMIT_MAX }, DRIVERS_LIMIT_MAX], ['past the maximum', { limit: 9999 }, DRIVERS_LIMIT_MAX]])(
    '%s: under MAX_READ_RESULT_BYTES with the most hires, overrides and headcount months', async (_n, extra, rows) => {
      vi.mocked(loadGridReadModel).mockResolvedValue(model({
        accounts: accounts as never, dimensions: { cc1, cc2: [], bu: [] },
        cells: accounts.flatMap((a, i) => MONTHS.map((m) => ({ glAccountId: a.id, cc1Id: cc1[i]!.id, cc2Id: null, buId: null, month: m, amount: WIDE, source: 'override' }))),
      }));
      vi.mocked(listDrivers).mockResolvedValue({ drivers: Array.from({ length: 300 }, (_, i) => line(i)) } as never);
      vi.mocked(listHires).mockResolvedValue({ hires: Array.from({ length: 500 }, (_, i) => ({ id: id(i, 'h'), label: long(120, 'Hire'), costCentreId: id(i, 'c'), startMonth: MONTHS[0]!, endMonth: MONTHS[14]!, fte: 9999.99, updatedAt: 'x' })) });
      vi.mocked(readHeadcount).mockResolvedValue({ costCentreId: null, months: MONTHS.map((month) => ({ month, payroll: 99999, hires: 9999.99, total: 109998.99 })), asOf: '2026-11-16T10:00:00.000Z' } as never);
      const r = await getBudgetDriversTool.handler({ version_id: VERSION, ...extra }, ctx('owner'));
      const out = JSON.parse(r.content[0]!.text) as { drivers: unknown[]; next_offset: number };
      expect([out.drivers.length, out.next_offset]).toEqual([rows, rows]);
      expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
    });
});

function worstRun() {
  const buckets = Object.fromEntries(BUCKET_KEYS.map((k) => [k, CENTS]));
  const sections = { currentAssets: CENTS, nonCurrentAssets: CENTS, totalAssets: CENTS, currentLiabilities: CENTS, nonCurrentLiabilities: CENTS, totalLiabilities: CENTS, equity: CENTS, check: CENTS };
  const direct = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`group${i}`, CENTS]));
  const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
  const doc = {
    ...defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: true, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } }),
    capex: many(20, (i) => ({ id: long(64, `cx${i}`), month: MONTHS[i % 15]!, amountExVat: 10_000_000_000_000, vatClaimable: true, description: long(200, 'Capex'), usefulLifeYears: 5 })),
    equity: { shareIssues: many(10, (i) => ({ id: long(64, `s${i}`), month: MONTHS[0]!, amount: 10_000_000_000_000 })), dividends: many(10, (i) => ({ id: long(64, `dv${i}`), declaredMonth: MONTHS[0]!, paidMonth: MONTHS[1]!, amount: 10_000_000_000_000 })) },
  };
  return {
    version: { id: VERSION, name: long(120, 'V'), kind: 'scenario', status: 'draft', fiscalYear: 2027, isPrimary: false, basedOnVersionId: VERSION },
    months: MONTHS, lookback: many(36, (i) => ({ month: `2023-${String((i % 12) + 1).padStart(2, '0')}`, turnover: CENTS, costOfSales: CENTS, supplierPurchases: CENTS })),
    opening: { asAt: '2026-02-28', provisional: true, buckets, balanceSheet: sections, totals: { assets: CENTS, liabilities: CENTS, equity: CENTS }, equity: { posted: CENTS, derivedRetainedEarnings: CENTS },
      unmapped: many(2000, (i) => ({ accountCode: long(20, `U${i}`), bucket: 'otherNonCurrentLiabilities', balance: CENTS })) },
    pnl: MONTHS.map((month) => ({ month, ...Object.fromEntries(PNL_BANDS.map((b) => [b, CENTS])), netProfit: CENTS })),
    balanceSheet: MONTHS.map((month) => ({ month, closing: buckets, sections })),
    cashFlow: { direct: MONTHS.map((month) => ({ month, openingCash: CENTS, direct, operating: CENTS, investing: CENTS, financing: CENTS, net: CENTS, closingCash: CENTS })),
      indirect: MONTHS.map((month) => ({ month, netProfit: CENTS, depreciation: CENTS, receivables: CENTS, inventory: CENTS, payables: CENTS, payrollLiabilities: CENTS, vat: CENTS, incomeTax: CENTS, operating: CENTS })) },
    runway: { minimumCash: CENTS, firstBelowMinimum: MONTHS[0], minCash: CENTS, minCashMonth: MONTHS[0] },
    checks: { balanced: false, unbalancedMonths: MONTHS, openingCash: { bucket: CENTS, ledger: CENTS, difference: CENTS, accounts: many(2000, (i) => ({ accountCode: long(20, `B${i}`), bucket: CENTS, ledger: CENTS })) } },
    warnings: [
      { code: 'unmapped_balance', accounts: many(2000, (i) => ({ accountCode: long(20, `U${i}`), bucket: 'otherEquity', balance: CENTS })) },
      { code: 'outside_months', entries: many(600, (i) => ({ list: 'capex', id: long(64, `e${i}`), skipped: 'entry', detail: long(120, 'Detail') })) },
      { code: 'negative_cash', months: MONTHS }, { code: 'opening_cash_difference', differenceCents: CENTS, accounts: many(2000, (i) => long(20, `A${i}`)) },
      ...MONTHS.map((month) => ({ code: 'negative_flow', month, flow: 'supplier_payments', amount: CENTS })),
    ],
    vatSettlements: many(8, () => ({ periodStart: MONTHS[0], periodEnd: MONTHS[1], net: CENTS, settleMonth: MONTHS[2], settled: true })),
    taxEvents: many(3, () => ({ month: MONTHS[5], kind: 'irp6_first', amount: CENTS })),
    assumptions: { resolved: doc, chain: [VERSION, VERSION], stored: { doc, updatedAt: '2026-11-16T10:00:00.000001Z', updatedBy: id(1, 'u') } },
  };
}

describe('get_three_way and derive_three_way', () => {
  it('every default section, lists cut at the cap, a document with long lists: under MAX_READ_RESULT_BYTES', async () => {
    vi.mocked(getThreeWay).mockResolvedValue(worstRun() as never);
    const r = await getThreeWayTool.handler({ version_id: VERSION }, ctx());
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text) as { opening: { unmapped: unknown[]; unmapped_total: number } };
    expect([out.opening.unmapped.length, out.opening.unmapped_total]).toEqual([THREE_WAY_LIST_CAP, 2000]);
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });

  it('derive: the proposal and its evidence', async () => {
    const run = worstRun();
    vi.mocked(deriveView).mockResolvedValue({ version: run.version, assumptions: run.assumptions.resolved, evidence: { asAt: '2026-02-28', window: { first: MONTHS[0], last: MONTHS[14], months: 36, days: 1095 }, trailing: { turnover: CENTS }, aging: { receivables: CENTS, payables: CENTS } } } as never);
    const r = await deriveThreeWayTool.handler({ version_id: VERSION }, ctx());
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });
});

describe('budget_remaining and budget_tracking', () => {
  it('200 lines, every figure the widest: under MAX_READ_RESULT_BYTES', async () => {
    vi.mocked(loadGridReadModel).mockResolvedValue(model());
    vi.mocked(registryYears).mockReturnValue({ forDate: vi.fn(async () => ({ fiscalYear: 2027 })), byLabel: vi.fn() } as never);
    vi.mocked(remainingFor).mockImplementation(async (_c, keys) => keys.map((key) => ({
      key, versionId: VERSION, grain: 'company', slice: { cc1Id: null, cc2Id: null, buId: null }, unassigned: false, offSlice: false, budget: WIDE, actual: WIDE, committed: WIDE, remaining: WIDE,
    })));
    const lines = Array.from({ length: 200 }, () => ({ account: '6000', month: '2026-03' }));
    const r = await budgetRemainingTool.handler({ lines }, ctx('manager'));
    expect(JSON.parse(r.content[0]!.text).answered).toBe(200);
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });

  it.each([['default', {}, ALERTS_LIMIT_DEFAULT], ['maximum', { limit: ALERTS_LIMIT_MAX }, ALERTS_LIMIT_MAX], ['past the maximum', { limit: 999 }, ALERTS_LIMIT_MAX]])(
    'budget_tracking %s page: under MAX_READ_RESULT_BYTES', async (_n, extra, rows) => {
      const alert = (i: number) => ({ id: id(i, 'x'), versionId: VERSION, glAccountId: id(i, 'a'), accountCode: long(20, 'C'), accountName: long(120, 'Account'), cc1Id: id(i, 'c'), cc2Id: null, buId: null,
        sliceName: long(150, 'Slice'), month: '2026-03', threshold: 999, budget: WIDE, actual: WIDE, committed: WIDE, pct: 99999.99, firedAt: '2026-03-31T00:00:00.000Z', resolvedAt: '2026-04-30T00:00:00.000Z', href: '/x' });
      vi.mocked(listBudgetAlerts).mockResolvedValue({ open: Array.from({ length: 200 }, (_, i) => alert(i)), resolved: [], lastEvaluated: { daily: null, manual: null } } as never);
      const r = await budgetTrackingTool.handler(extra, ctx('admin'));
      expect((JSON.parse(r.content[0]!.text) as { items: unknown[] }).items).toHaveLength(rows);
      expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
    });
});
