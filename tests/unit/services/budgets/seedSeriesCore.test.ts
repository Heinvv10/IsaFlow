import { describe, expect, it } from 'vitest';
import { pySeriesFrom, versionSeriesFrom, type SeedAccountFacts } from '@/modules/accounting/services/budgets/seedSeriesCore';

const months = ['2027-01', '2027-02', '2027-03'];
const acct = (id: string, over: Partial<SeedAccountFacts> = {}): SeedAccountFacts => ({ id, isActive: true, isHeader: false, ...over });
const ACCOUNTS = new Map([acct('a'), acct('b'), acct('hdr', { isHeader: true }), acct('off', { isActive: false }), acct('idle')].map((a) => [a.id, a]));
const c = (glAccountId: string, month: string, amount: number, dimensionId: string | null = null) => ({ glAccountId, dimensionId, month, amount });
const OPT = { grain: 'company', unassigned: 'company', includeNoActivity: false } as const;
const prior = (cells: ReturnType<typeof c>[]) => ({ months, cells });

describe('pySeriesFrom', () => {
  it('builds dense company series in cents, sorted by key, and counts skipped headers / inactive accounts', () => {
    const r = pySeriesFrom(prior([c('b', '2027-02', 2.5), c('a', '2027-01', 1.1), c('a', '2027-03', 3), c('hdr', '2027-01', 9), c('off', '2027-01', 9)]), ACCOUNTS, new Set(), OPT);
    expect(r.series.map((s) => [s.glAccountId, s.cents, s.positions])).toEqual([['a', [110, 0, 300], [0, 1, 2]], ['b', [0, 250, 0], [0, 1, 2]]]);
    expect(r.skipped).toBe(2);
  });

  it('ignores accounts whose months are all zero, and cells outside the year', () => {
    const r = pySeriesFrom(prior([c('a', '2027-01', 0), c('b', '2030-01', 5)]), ACCOUNTS, new Set(), OPT);
    expect(r.series).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('dimension grain: tagged series per member; unassigned "company" turns the whole account company grain; "drop" keeps tagged only', () => {
    const cells = [c('a', '2027-01', 3, 'm1'), c('a', '2027-02', 1, null), c('b', '2027-01', 2, 'm1'), c('b', '2027-02', 4, 'm2')];
    const members = new Set(['m1', 'm2']);
    const keep = pySeriesFrom(prior(cells), ACCOUNTS, members, { ...OPT, grain: 'cc1', unassigned: 'company' });
    expect(keep.series.map((s) => [s.glAccountId, s.cc1Id, s.cents])).toEqual([['a', null, [300, 100, 0]], ['b', 'm1', [200, 0, 0]], ['b', 'm2', [0, 400, 0]]]);
    const drop = pySeriesFrom(prior(cells), ACCOUNTS, members, { ...OPT, grain: 'cc1', unassigned: 'drop' });
    expect(drop.series.map((s) => [s.glAccountId, s.cc1Id, s.cents])).toEqual([['a', 'm1', [300, 0, 0]], ['b', 'm1', [200, 0, 0]], ['b', 'm2', [0, 400, 0]]]);
  });

  it('a member the budget cannot take counts as unassigned; null members accepts every member', () => {
    const cells = [c('a', '2027-01', 3, 'ghost')];
    expect(pySeriesFrom(prior(cells), ACCOUNTS, new Set(['m1']), { ...OPT, grain: 'bu', unassigned: 'drop' }).series).toEqual([]);
    expect(pySeriesFrom(prior(cells), ACCOUNTS, null, { ...OPT, grain: 'bu', unassigned: 'drop' }).series.map((s) => s.buId)).toEqual(['ghost']);
  });

  it('includeNoActivity adds zero company rows for idle leaf accounts only', () => {
    const r = pySeriesFrom(prior([c('a', '2027-01', 1)]), ACCOUNTS, new Set(), { ...OPT, includeNoActivity: true });
    expect(r.series.map((s) => s.glAccountId)).toEqual(['a', 'b', 'idle']);
    expect(r.series.find((s) => s.glAccountId === 'idle')!.cents).toEqual([0, 0, 0]);
  });
});

describe('versionSeriesFrom', () => {
  const row = (glAccountId: string, month: string, amount: number, cc1Id: string | null = null) => ({ glAccountId, cc1Id, cc2Id: null, buId: null, month, amount });
  it('maps months by position, drops months past the target, keeps only budgeted months, sums rows of one series', () => {
    const src = ['2026-01', '2026-02', '2026-03', '2026-04'];
    const r = versionSeriesFrom([row('a', '2026-01', 1), row('a', '2026-01', 2), row('a', '2026-03', 4), row('a', '2026-04', 9), row('x', '2025-01', 7)], src, 3);
    expect(r).toEqual([{ glAccountId: 'a', cc1Id: null, cc2Id: null, buId: null, positions: [0, 2], cents: [300, 400] }]);
  });
});
