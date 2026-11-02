/**
 * The approval gate's per-(account, CC1) comparison for a recalculated run
 * (PR #1065 review rounds 1–2): a journal from before CC1, a centre
 * deactivated since posting, and — round 2 — a move between centres the plan
 * cannot tag today, which merging them into one untagged bucket hid (M1).
 */
import { describe, it, expect } from 'vitest';
import { comparableLines, sameFigures, type FigureLine, type LabourSourceBucket } from '@/modules/accounting/services/payroll/payrollLabourComparison';

const A5210 = 'acct-5210';
const credits: FigureLine[] = [{ glAccountId: 'acct-1110', debit: 0, credit: 1000, cc1Id: null }];
const posted = (...labour: Array<[string | null, number]>): FigureLine[] =>
  [...labour.map(([cc1Id, debit]) => ({ glAccountId: A5210, debit, credit: 0, cc1Id })), ...credits];
const source = (...b: Array<[string | null, boolean, number]>): LabourSourceBucket[] =>
  b.map(([centreId, taggable, debit]) => ({ glAccountId: A5210, centreId, taggable, debit }));
/** The plan's posted lines as the builder makes them: untaggable centres merged into untagged. */
const planLines = (bySource: LabourSourceBucket[]): FigureLine[] => {
  const m = new Map<string | null, number>();
  for (const b of bySource) { const k = b.taggable ? b.centreId : null; m.set(k, (m.get(k) ?? 0) + b.debit); }
  return [...[...m].map(([cc1Id, debit]) => ({ glAccountId: A5210, debit, credit: 0, cc1Id })), ...credits];
};
const same = (bySource: LabourSourceBucket[], journal: FigureLine[]) =>
  sameFigures(comparableLines(planLines(bySource), bySource, journal), true);

describe('comparableLines + sameFigures (recalculated run)', () => {
  it('a journal with no CC1 on any labour line is compared per account: unchanged re-locks', () => {
    expect(same(source(['A', true, 600], ['B', true, 400]), posted([null, 1000]))).toBe(true);
    expect(same(source(['A', true, 600], ['B', true, 500]), posted([null, 1000]))).toBe(false);
  });

  it('a centre deactivated since posting still equals its posted line', () => {
    expect(same(source(['A', true, 600], ['B', false, 400]), posted(['A', 600], ['B', 400]))).toBe(true);
  });

  it('M1: a move between two centres both deactivated since posting is still a difference', () => {
    expect(same(source(['A', false, 500], ['B', false, 500]), posted(['A', 600], ['B', 400]))).toBe(false);
  });

  it('a centre untaggable at posting too compares with the journal\'s untagged line', () => {
    expect(same(source(['A', true, 600], ['OLD', false, 300], [null, false, 100]), posted(['A', 600], [null, 400]))).toBe(true);
    expect(same(source(['A', true, 500], ['OLD', false, 400], [null, false, 100]), posted(['A', 600], [null, 400]))).toBe(false);
  });

  it('a centre the plan tags that the journal does not carry is a difference (fail closed)', () => {
    expect(same(source(['A', true, 600], ['C', true, 400]), posted(['A', 600], [null, 400]))).toBe(false);
  });

  it('a real move between two tagged centres on one account is a difference', () => {
    expect(same(source(['A', true, 500], ['B', true, 500]), posted(['A', 600], ['B', 400]))).toBe(false);
  });

  it('without a source breakdown the plan\'s own lines are compared', () => {
    const lines = posted(['A', 1000]);
    expect(comparableLines(lines, undefined, lines)).toEqual({ plan: lines, posted: lines });
  });
});
