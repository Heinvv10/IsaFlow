/**
 * The caveats a reclassification has to carry.
 *
 * The one that matters: on the live Velocity books, 36 of the 37 unclassified
 * expense accounts are correctly named and correctly loaded and merely lack an
 * `account_subtype`. Moving them onto a generic target destroys the split
 * between Direct Material, Sub-Contractors and Wayleave, while setting the
 * subtype achieves the reporting goal and moves nothing. A tool that will do the
 * first without saying so is not finished, so these warnings are tested like
 * behaviour rather than treated as copy.
 */
import { describe, it, expect } from 'vitest';
import { reclassWarnings } from '@/modules/accounting/services/gl/reclassification/warnings';
import type { ReclassImpact } from '@/modules/accounting/services/gl/reclassification/impact';
import type { ClassifiedFigures } from '@/modules/accounting/services/gl/accountClassification';

const SRC = 'src-id';
const TGT = 'tgt-id';

function figures(over: Partial<ClassifiedFigures> = {}): ClassifiedFigures {
  return {
    revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0,
    operatingExpenses: 0, otherExpenses: 0, depreciation: 0,
    // Required on ClassifiedFigures. tsconfig excludes tests/**, so a missing
    // field here is invisible to tsc and to vitest: it would sit as `undefined`
    // behind the annotation and, the moment anyone adds operatingProfit to
    // PL_BANDS, `compareToOwner` would do undefined - undefined -> NaN and
    // report "no drift" — the exact failure the _bandsAreNumeric compile-time
    // guard exists to prevent, defeated because it cannot reach test files.
    operatingProfit: 0,
    netProfit: 0,
    totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
    currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
    cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
    unclassifiedCount: 0, unclassifiedTotal: 0,
    unclassifiedByType: {
      asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
      equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
      expense: { accounts: 0, amount: 0 },
    },
    ...over,
  };
}

function impact(over: Partial<ReclassImpact> = {}): ReclassImpact {
  return {
    window: { start: '2026-04-01', end: '2026-04-30' },
    profitAndLossBefore: figures({ operatingExpenses: 1000, netProfit: -1000 }),
    profitAndLossAfter: figures({ costOfSales: 1000, netProfit: -1000 }),
    accounts: [
      { accountId: SRC, accountCode: '49775627', accountName: 'Unallocated Expense',
        before: 1000, after: 0, grossBefore: 1000, grossAfter: 0,
        lineCountBefore: 1, lineCountAfter: 0 },
      { accountId: TGT, accountCode: '5100', accountName: 'Materials & Supplies',
        before: 0, after: 1000, grossBefore: 0, grossAfter: 1000,
        lineCountBefore: 0, lineCountAfter: 1 },
    ],
    ...over,
  };
}

const line = {
  lineId: 'l1', journalEntryId: 'e1', entryNumber: 'JE-1', entryDate: '2026-04-15',
  debit: 1000, credit: 0, description: null, projectId: null, costCenterId: null,
};

const base = {
  universeTotal: 1,
  source: { id: SRC, code: '49775627', name: 'Unallocated Expense', type: 'expense', subtype: null },
  target: { id: TGT, code: '5100', name: 'Materials & Supplies', type: 'expense', subtype: 'cost_of_sales' },
  movable: [line],
  impact: impact(),
  priorSources: 0,
};

const codes = (input: Parameters<typeof reclassWarnings>[0]) =>
  reclassWarnings(input).map((w) => w.code);

describe('reclassWarnings', () => {
  it('names the subtype remedy when the source only lacks a subtype', () => {
    const warnings = reclassWarnings(base);
    const remedy = warnings.find((w) => w.code === 'subtype_remedy_available');
    expect(remedy).toBeDefined();
    // The remedy has to be actionable, not a shrug.
    expect(remedy!.detail).toContain('update_gl_account');
    expect(remedy!.detail).toContain('MOVES NOTHING');
  });

  it('does NOT offer the subtype remedy when the source is already classified', () => {
    expect(codes({ ...base, source: { ...base.source, subtype: 'operating_expense' } }))
      .not.toContain('subtype_remedy_available');
  });

  it('warns that a target already carrying lines merges the two identities', () => {
    const withValue = impact();
    withValue.accounts[1]!.lineCountBefore = 42;
    expect(codes({ ...base, impact: withValue })).toContain('collapses_named_accounts');
    expect(codes(base)).not.toContain('collapses_named_accounts');
  });

  it('warns when another account has ALREADY been reclassified into this target', () => {
    // The collapse arises across calls: one call moves one account, and the
    // detail is only lost once a second lands on the same target.
    expect(codes({ ...base, priorSources: 2 })).toContain('collapses_named_accounts');
  });

  it('warns that a cross-type move crosses the P&L / balance sheet line', () => {
    expect(codes({ ...base, target: { ...base.target, type: 'asset' } }))
      .toContain('crosses_account_type');
  });

  it('warns when a clearing account nets to nothing against a large gross', () => {
    // 49775626 Unallocated Income: R31.6m gross, −R659k net. A net-based
    // reading calls that harmless while 109 lines change account.
    const clearing = impact();
    clearing.accounts[0]!.grossBefore = 31_613_903.28;
    clearing.accounts[0]!.before = -658_669.46;
    const warning = reclassWarnings({ ...base, impact: clearing })
      .find((w) => w.code === 'net_movement_near_zero');
    expect(warning).toBeDefined();
    // Formatted en-ZA: comma decimal separator, non-breaking-space thousands
    // separator. Assert on the digits, not the punctuation.
    expect(warning!.detail.replace(/[^0-9]/g, '')).toContain('3161390328');
    expect(warning!.detail.replace(/[^0-9]/g, '')).toContain('65866946');
  });

  it('says plainly when the move changes NO reported figure', () => {
    // The live case: 49775627 (NULL subtype) and 5100 (default_expense) both
    // land in operating expenses, so moving 414 lines and R11.3m moves no band.
    const same = figures({ operatingExpenses: 1000, netProfit: -1000 });
    const warning = reclassWarnings({
      ...base,
      impact: impact({ profitAndLossBefore: same, profitAndLossAfter: { ...same } }),
    }).find((w) => w.code === 'no_profit_and_loss_effect');
    expect(warning).toBeDefined();
    expect(warning!.detail).toContain('IDENTICAL');
  });

  it('does NOT claim "no effect" when a band actually moves', () => {
    expect(codes(base)).not.toContain('no_profit_and_loss_effect');
  });

  it('does NOT claim "no effect" when there is nothing to move', () => {
    const same = figures();
    expect(codes({
      ...base, movable: [],
      impact: impact({ profitAndLossBefore: same, profitAndLossAfter: { ...same } }),
    })).not.toContain('no_profit_and_loss_effect');
  });

  it('says an empty source account read NOTHING, rather than leaving zeros to speak', () => {
    // A brand-new tenant. Every figure is zero because nothing was read, not
    // because a total came to zero, and those are different facts.
    const warning = reclassWarnings({ ...base, universeTotal: 0, movable: [] })
      .find((w) => w.code === 'no_source_lines');
    expect(warning).toBeDefined();
    expect(warning!.detail).toContain('nothing was read');
  });

  it('does NOT claim an empty source when the account has candidate lines', () => {
    expect(codes(base)).not.toContain('no_source_lines');
  });

  it('surfaces a disagreement with the owning P&L service instead of hiding it', () => {
    expect(codes({ ...base, impact: impact({ basisFault: 'revenue: 1 vs 2' }) }))
      .toContain('basis_disagreement');
  });
});
