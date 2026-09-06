/**
 * Page 11 assembly — not the sources. Every source is mocked; these tests
 * pin company scoping, quantum ranking, the "no matters" fallback (spec
 * §7.1 criterion 3: an empty page never ships), and the rule this file
 * exists to enforce: a source that throws becomes a NAMED matter, never a
 * silent omission.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgingReport } from '@/modules/accounting/services/reports/agingReportService';
import type { UnusualJournalFlag } from '@/modules/accounting/services/reports/unusualJournalsService';
import type { OverdueFiling } from '@/modules/accounting/services/reports/statutoryFilingsService';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';

// Hoisted: `vi.mock` factories run before module-level consts are initialised.
const { agingSpy, bankSpy, journalSpy, filingSpy, warn } = vi.hoisted(() => ({
  agingSpy: vi.fn(),
  bankSpy: vi.fn(),
  journalSpy: vi.fn(),
  filingSpy: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/agingReportService', () => ({
  getAgingReport: agingSpy,
}));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({
  getBankAccountsStatus: bankSpy,
}));
vi.mock('@/modules/accounting/services/reports/unusualJournalsService', () => ({
  getUnusualJournals: journalSpy,
}));
vi.mock('@/modules/accounting/services/reports/statutoryFilingsService', () => ({
  getOverdueStatutoryFilings: filingSpy,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

import { buildMatters } from '@/modules/accounting/services/packs/pages/packMatters';

const window: PeriodWindow = { start: '2026-01-01', end: '2026-08-31' };

function emptyAging(): AgingReport {
  return {
    asAt: window.end,
    buckets: [],
    totals: { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, total: 0 },
    excluded: [],
    excludedTotal: 0,
    entityUniverse: 0,
    unappliedReceipts: 0,
    subledgerTotal: 0,
    postedThrough: null,
  };
}

/** `largestTotal` is the single biggest debtor's balance; `otherTotals` are
 *  spread across several smaller entities (each strictly below
 *  `largestTotal`), so the fixture cannot accidentally make some OTHER
 *  entity the largest. `totals.total` is the sum of all of them. */
function agingWithConcentration(largestTotal: number, otherTotals: number[]): AgingReport {
  const buckets = [
    {
      entityId: 'e0', entityName: 'Big Debtor',
      current: largestTotal, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: largestTotal,
    },
    ...otherTotals.map((total, i) => ({
      entityId: `e${i + 1}`, entityName: `Other Debtor ${i + 1}`,
      current: total, days30: 0, days60: 0, days90: 0, days120Plus: 0, total,
    })),
  ];
  const grandTotal = largestTotal + otherTotals.reduce((s, t) => s + t, 0);
  return {
    ...emptyAging(),
    buckets,
    totals: { current: grandTotal, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, total: grandTotal },
  };
}

/** Every source resolves to an empty/clean result — the fixture for the
 *  "no matters" test and the default for tests that only care about one
 *  source misbehaving. */
function everySourceEmpty(): void {
  agingSpy.mockResolvedValue(emptyAging());
  bankSpy.mockResolvedValue([]);
  journalSpy.mockResolvedValue([]);
  filingSpy.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  everySourceEmpty();
});

describe('buildMatters', () => {
  it('scopes every source query to the company', async () => {
    await buildMatters('c1', window);
    for (const spy of [agingSpy, journalSpy, filingSpy, bankSpy]) {
      expect(spy).toHaveBeenCalled();
      for (const call of spy.mock.calls) expect(call[0]).toBe('c1');
    }
  });

  it('ranks matters by quantum, largest first', async () => {
    // Deliberately NOT in descending order across sources, and deliberately
    // mixes in a null-quantum matter (the overdue filing) so a fixture that
    // is already sorted, or one where every quantum is non-null, cannot pass
    // a broken implementation by accident.
    agingSpy.mockResolvedValue(agingWithConcentration(50_000, [40_000, 40_000, 30_000, 30_000])); // 25% of 200,000 -> flagged, quantum 50,000
    bankSpy.mockResolvedValue([{ unreconciled_count: 2, unreconciled_balance: 20_000 }]);
    const journalFlags: UnusualJournalFlag[] = [
      { entryId: 'j1', entryNumber: 'JE-1', entryDate: '2026-03-01', description: 'Estimate', amount: 90_000, reason: 'round_number' },
      { entryId: 'j2', entryNumber: 'JE-2', entryDate: '2026-04-01', description: 'Late entry', amount: 5_000, reason: 'backdated' },
    ];
    journalSpy.mockResolvedValue(journalFlags);
    const filings: OverdueFiling[] = [
      { filingType: 'Annual Financial Statements', fiscalYear: 2025, deadline: '2026-03-31', daysOverdue: 10 },
    ];
    filingSpy.mockResolvedValue(filings);

    const matters = await buildMatters('c1', window);
    const quanta = matters.map((m) => Math.abs(m.quantum ?? 0));
    expect([...quanta].sort((a, b) => b - a)).toEqual(quanta);
    // Pin the actual order, not just "is sorted" — a fixture where every
    // quantum happens to already be descending can't distinguish a real sort
    // from no sort at all.
    expect(quanta).toEqual([90_000, 50_000, 20_000, 5_000, 0]);
  });

  it('returns an explicit "no matters" item rather than an empty page', async () => {
    // Rubric criterion 3: a page with nothing on it does not ship.
    everySourceEmpty();
    const matters = await buildMatters('c1', window);
    expect(matters).toHaveLength(1);
    expect(matters[0]?.issue).toMatch(/no matters/i);
    expect(matters[0]?.quantum).toBeNull();
  });

  it('reports a source that failed rather than silently omitting its matters', async () => {
    agingSpy.mockRejectedValue(new Error('timeout'));
    const matters = await buildMatters('c1', window);
    expect(matters.some((m) => m.issue.match(/aged debtors could not be assessed/i))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('does not let one failed source suppress the matters from the others', async () => {
    agingSpy.mockRejectedValue(new Error('timeout'));
    bankSpy.mockResolvedValue([{ unreconciled_count: 3, unreconciled_balance: 15_000 }]);
    const matters = await buildMatters('c1', window);
    expect(matters.some((m) => m.issue.match(/aged debtors could not be assessed/i))).toBe(true);
    expect(matters.some((m) => m.issue.match(/unreconciled bank item/i))).toBe(true);
  });
});
