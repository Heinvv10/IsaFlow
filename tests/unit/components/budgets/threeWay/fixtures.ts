/**
 * Three-way fixtures for the component tests: a REAL engine run (`runThreeWay`, pure) shaped as the route's
 * answer, so the grids and chips read what the server would send. F1-like: not VAT-registered, cash R100 000,
 * turnover R31 000 a month, opex R15 500, debtor days 30 (the defaults).
 */
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { emptyBuckets, emptyPnl } from '@/modules/accounting/services/budgets/threeWay/types';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import type { AssumptionsView, ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import type { BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';

export const V1 = '11111111-1111-4111-8111-111111111111';
export const V2 = '22222222-2222-4222-8222-222222222222';
export const MONTHS = ['2026-03', '2026-04', '2026-05'];

export function assumptions(): ThreeWayAssumptions {
  return defaultAssumptions({
    priorYearEnd: '2026-02', entityType: 'pty_ltd', asAt: '2026-02-28',
    vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' },
  });
}

export function version(over: Partial<BudgetVersion> = {}): BudgetVersion {
  return {
    id: V1, fiscalYear: 2027, name: 'FY2027 Plan', kind: 'original', status: 'draft', basedOnVersionId: null, isPrimary: true,
    approvedBy: null, approvedAt: null, lockedBy: null, lockedAt: null, unlockedBy: null, unlockedAt: null, unlockReason: null,
    createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', ...over,
  } as BudgetVersion;
}

export function threeWayView(over: { provisional?: boolean; status?: BudgetVersion['status'] } = {}): ThreeWayView {
  const a = assumptions();
  const out = runThreeWay({
    months: MONTHS, entityType: 'pty_ltd',
    pnl: MONTHS.map(() => ({ ...emptyPnl(), turnover: 31_000_00, otherOpex: 15_500_00 })),
    lookback: [],
    opening: { asAt: '2026-02-28', provisional: over.provisional ?? false, buckets: { ...emptyBuckets(), cash: 100_000_00, shareCapital: -100_000_00 } },
    assumptions: a, loanSchedules: [],
  });
  return {
    version: { id: V1, name: 'FY2027 Plan', kind: 'original', status: over.status ?? 'draft', fiscalYear: 2027, isPrimary: true, basedOnVersionId: null },
    months: MONTHS,
    opening: {
      asAt: out.opening.asAt, provisional: out.opening.provisional, buckets: out.opening.buckets, balanceSheet: out.opening.balanceSheet,
      totals: { assets: 100_000_00, liabilities: 0, equity: 100_000_00 }, equity: { posted: 100_000_00, derivedRetainedEarnings: 0 }, unmapped: [],
    },
    pnl: out.months.map((m) => ({ month: m.month, ...m.pnl })),
    balanceSheet: out.months.map((m) => ({ month: m.month, closing: m.closing, sections: m.balanceSheet })),
    cashFlow: {
      direct: out.months.map((m) => {
        const { indirect: _i, ...d } = m.cashFlow;
        return { month: m.month, ...d };
      }),
      indirect: out.months.map((m) => ({ month: m.month, ...m.cashFlow.indirect })),
    },
    runway: out.runway,
    checks: { balanced: true, unbalancedMonths: [], openingCash: { bucket: 100_000_00, ledger: 100_000_00, difference: 0, accounts: [] } },
    warnings: out.warnings,
    vatSettlements: out.vatSettlements,
    taxEvents: out.taxEvents,
    assumptions: { resolved: a, chain: [V1], stored: null },
  };
}

export function assumptionsView(over: { debtorDays?: number; updatedAt?: string | null; status?: BudgetVersion['status'] } = {}): AssumptionsView {
  const a = assumptions();
  const resolved: ThreeWayAssumptions = over.debtorDays === undefined ? a
    : { ...a, workingCapital: { ...a.workingCapital, debtorDays: { value: over.debtorDays, source: 'manual' } } };
  return {
    version: { id: V1, name: 'FY2027 Plan', kind: 'original', status: over.status ?? 'draft', fiscalYear: 2027, isPrimary: true, basedOnVersionId: null },
    stored: over.updatedAt ? { doc: resolved, updatedAt: over.updatedAt, updatedBy: 'u' } : null,
    resolved,
    chain: [V1],
    derived: {
      assumptions: a,
      evidence: {
        asAt: '2026-02-28', window: { first: null, last: null, months: 0, days: 0 },
        trailing: { turnover: 0, costOfSales: 0, supplierPurchases: 0, payroll: 0, statutoryPayroll: 0 },
        vat: null, statutory: 0, opening: { receivables: 0, payables: 0, inventory: 0 }, insufficientHistory: true,
        payableAccounts: { incomeTaxPayable: { account: null, basis: 'no account named like income tax' }, dividendsPayable: { account: null, basis: 'none' } },
      },
    },
  };
}
