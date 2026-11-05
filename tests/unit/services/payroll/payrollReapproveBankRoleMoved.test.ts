/**
 * Breaker L-1: a reopened run whose journal is IN FORCE, unchanged in every
 * figure, must re-lock onto it after the bank role moved (or lost its holder).
 * The gate's comparison keyed every credit by GL account, and the plan's
 * net-pay credit names TODAY's holder while the journal names whoever held the
 * role when it posted. `foldNetPayBank` compares that credit as one role, by
 * amount. A changed amount anywhere is still a difference.
 */
import { describe, it, expect } from 'vitest';
import {
  comparableLines, foldNetPayBank, NET_PAY_DESCRIPTION, sameFigures, type FigureLine,
} from '@/modules/accounting/services/payroll/payrollLabourComparison';

const OLD_BANK = 'aaaaaaaa-0000-0000-0000-000000000001';
const NEW_BANK = 'bbbbbbbb-0000-0000-0000-000000000002';
const LABOUR = 'cccccccc-0000-0000-0000-000000000003';
const PAYE = 'dddddddd-0000-0000-0000-000000000004';
const UIF = 'eeeeeeee-0000-0000-0000-000000000005';

type PlanLine = FigureLine & { description: string };
const planLine = (glAccountId: string | null, debit: number, credit: number, description: string): PlanLine =>
  ({ glAccountId, debit, credit, cc1Id: null, description });
const plan = (bank: string | null, net = 18_200): PlanLine[] => [
  planLine(LABOUR, 22_200, 0, 'Labour'),
  planLine(PAYE, 0, 2_000, 'PAYE'),
  planLine(UIF, 0, 2_000, 'UIF'),
  planLine(bank, 0, net, NET_PAY_DESCRIPTION),
];
/** The journal as the poster wrote it: each line keeps the plan's description (gl_journal_lines.description). */
type PostedLine = FigureLine & { description: string };
const journal = (bank: string, net = 18_200, paye = 2_000): PostedLine[] => [
  { glAccountId: LABOUR, debit: 22_200, credit: 0, cc1Id: null, description: 'Labour' },
  { glAccountId: PAYE, debit: 0, credit: paye, cc1Id: null, description: 'PAYE' },
  { glAccountId: UIF, debit: 0, credit: 2_000, cc1Id: null, description: 'UIF' },
  { glAccountId: bank, debit: 0, credit: net, cc1Id: null, description: NET_PAY_DESCRIPTION },
];
const same = (p: PlanLine[], posted: PostedLine[], perAccount = false): boolean => {
  const folded = foldNetPayBank(p, posted);
  return sameFigures(perAccount ? comparableLines(folded.plan, undefined, folded.posted) : folded, perAccount);
};

describe.each([false, true])('re-approval onto an in-force journal (recalculated since posting: %s)', (perAccount) => {
  it('same figures, bank role moved to another account: re-locks', () => {
    expect(same(plan(NEW_BANK), journal(OLD_BANK), perAccount)).toBe(true);
  });

  it('same figures, no account holds the role now (the plan names none): re-locks', () => {
    expect(same(plan(null), journal(OLD_BANK), perAccount)).toBe(true);
  });

  it('same figures, role not moved: still re-locks', () => {
    expect(same(plan(OLD_BANK), journal(OLD_BANK), perAccount)).toBe(true);
  });

  it('a changed net amount is still a difference after the role moved', () => {
    expect(same(plan(NEW_BANK, 18_300), journal(OLD_BANK), perAccount)).toBe(false);
  });

  it('a changed non-bank credit is still a difference after the role moved', () => {
    expect(same(plan(NEW_BANK), journal(OLD_BANK, 18_200, 1_900), perAccount)).toBe(false);
  });

  it('a credit the plan has moved to a different account is a difference, not "the bank"', () => {
    const remapped = plan(NEW_BANK).map((l) => (l.glAccountId === PAYE ? { ...l, glAccountId: 'ffffffff-0000-0000-0000-000000000006' } : l));
    expect(same(remapped, journal(OLD_BANK), perAccount)).toBe(false);
  });

  it('a journal credit the plan no longer carries is a difference', () => {
    // Balanced: the plan drops the UIF credit and net pay rises by it (22,200 = 2,000 PAYE + 20,200 bank).
    const noUif = plan(NEW_BANK, 20_200).filter((l) => l.glAccountId !== UIF);
    const credits = noUif.reduce((s, l) => s + l.credit, 0);
    expect(credits).toBe(noUif.reduce((s, l) => s + l.debit, 0));
    expect(same(noUif, journal(OLD_BANK), perAccount)).toBe(false);
  });
});

describe('a posted journal without the net-pay description', () => {
  it('is compared account by account: no fold, so a moved role reads as a change', () => {
    const noDescription = journal(OLD_BANK).map((l) => ({ ...l, description: 'Payroll' }));
    expect(same(plan(NEW_BANK), noDescription)).toBe(false);
    expect(same(plan(OLD_BANK), noDescription)).toBe(true);
  });
});

describe('without the fold (the reviewer\'s repro), account-keyed figures differ', () => {
  it('keys the net-pay credit by account id, so the moved role reads as a change', () => {
    expect(sameFigures({ plan: plan(NEW_BANK), posted: journal(OLD_BANK) }, false)).toBe(false);
  });
});
