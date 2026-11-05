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
  it('an untagged plan and journal are compared per account: unchanged re-locks', () => {
    expect(same(source(['A', false, 600], ['B', false, 400]), posted([null, 1000]))).toBe(true);
    expect(same(source(['A', false, 600], ['B', false, 500]), posted([null, 1000]))).toBe(false);
  });

  it('does not re-lock an untagged journal after labour moves to a tagged centre on the same account', () => {
    expect(same(source(['A', true, 1000]), posted([null, 1000]))).toBe(false);
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

/**
 * A run NOT recalculated since posting is compared against the journal as it
 * stands now (payrollApprovalGate: `linked.lines`). A cost centre put on a
 * credit line after posting (tag_journal_lines; 2175, say) is the ledger being
 * retagged, not the run changing, so it is not a difference. The figures still are.
 */
describe('sameFigures, run not recalculated since posting (perAccount = false)', () => {
  const DED = 'acct-2175';
  const CC = 'centre-1';
  const plan: FigureLine[] = [
    { glAccountId: A5210, debit: 1500, credit: 0, cc1Id: null },
    { glAccountId: DED, debit: 0, credit: 500, cc1Id: null },
    { glAccountId: 'acct-1110', debit: 0, credit: 1000, cc1Id: null },
  ];
  const tagged = (cc1Id: string | null, over: Partial<Record<string, number>> = {}): FigureLine[] => plan.map((l) => ({
    ...l,
    credit: over[l.glAccountId ?? ''] ?? l.credit,
    cc1Id: l.glAccountId === DED ? cc1Id : l.cc1Id,
  }));

  it('a cost centre tagged onto a credit line after posting is not a difference', () => {
    expect(sameFigures({ plan, posted: tagged(CC) }, false)).toBe(true);
  });

  it('a credit that was tagged at posting and cleared since is not a difference either', () => {
    expect(sameFigures({ plan: tagged(CC), posted: plan }, false)).toBe(true);
  });

  it('the figures are still compared: a changed credit is a difference, tagged or not', () => {
    expect(sameFigures({ plan, posted: tagged(CC, { [DED]: 499.99 }) }, false)).toBe(false);
    expect(sameFigures({ plan, posted: tagged(null, { [DED]: 499.99 }) }, false)).toBe(false);
  });

  it('a recalculated run still sees a credit line\'s cost centre (per account and CC1)', () => {
    expect(sameFigures({ plan, posted: tagged(CC) }, true)).toBe(false);
  });
});
