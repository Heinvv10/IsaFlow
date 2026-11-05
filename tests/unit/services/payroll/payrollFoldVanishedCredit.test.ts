/**
 * Breaker L2-1: foldNetPayBank folds EVERY posted credit-only line whose account
 * the new plan no longer uses into the bank bucket. Both journals balance, so
 * when labour and every credit the plan still carries are equal, the bank
 * bucket is equal by arithmetic. A credit that went to zero (PAYE, 2175) and
 * moved into net pay is therefore invisible: the run re-locks onto a journal
 * that still books the old PAYE / deduction liability and under-credits bank.
 *
 * Each case asserts the CORRECT outcome (a difference). Fixed by folding exactly ONE
 * posted line: the one carrying the net-pay description.
 */
import { describe, it, expect } from 'vitest';
import {
  comparableLines, foldNetPayBank, NET_PAY_DESCRIPTION, sameFigures, type FigureLine,
} from '@/modules/accounting/services/payroll/payrollLabourComparison';

const BANK = 'aaaaaaaa-0000-0000-0000-000000000001';
const LABOUR = 'cccccccc-0000-0000-0000-000000000003';
const PAYE = 'dddddddd-0000-0000-0000-000000000004';
const UIF = 'eeeeeeee-0000-0000-0000-000000000005';
const SDL = 'ffffffff-0000-0000-0000-000000000006';
const DED = '99999999-0000-0000-0000-000000000007';

type PlanLine = FigureLine & { description: string };
type PostedLine = FigureLine & { description: string };
const pl = (id: string | null, debit: number, credit: number, description: string): PlanLine =>
  ({ glAccountId: id, debit, credit, cc1Id: null, description });

/** Exactly what the builder emits: zero lines dropped. gross 20000, UIF 400 (200/200), SDL 200. */
function plan(paye: number, ded: number, bank: string | null = BANK): PlanLine[] {
  const net = 20_000 - paye - 200 - ded;
  return [
    pl(LABOUR, 20_400, 0, 'Labour'),
    pl(PAYE, 0, paye, 'PAYE payable, net of ETI'),
    pl(UIF, 0, 400, 'UIF'),
    pl(SDL, 0, 200, 'SDL'),
    pl(bank, 0, net, NET_PAY_DESCRIPTION),
    pl(DED, 0, ded, 'Other employee deductions'),
  ].filter((l) => l.debit !== 0 || l.credit !== 0);
}
/** A journal as the poster wrote it: every line carries its plan description. */
const journalOf = (p: PlanLine[]): PostedLine[] => p.map((l) => ({ glAccountId: l.glAccountId!, debit: l.debit, credit: l.credit, cc1Id: null, description: l.description }));

const gate = (p: PlanLine[], posted: PostedLine[], perAccount: boolean): boolean => {
  const folded = foldNetPayBank(p, posted);
  return sameFigures(perAccount ? comparableLines(folded.plan, undefined, folded.posted) : folded, perAccount);
};

describe.each([false, true])('re-approval onto an in-force journal (perAccount=%s)', (perAccount) => {
  it('PAYE recalculated to zero, net pay up by the same amount, role NOT moved: must be a difference', () => {
    const posted = journalOf(plan(2_000, 0));    // CR PAYE 2000, CR bank 17800
    const now = plan(0, 0);                      // no PAYE line, CR bank 19800
    // Pre-branch (account-keyed) comparison sees it:
    expect(sameFigures({ plan: now, posted }, perAccount)).toBe(false);
    // The branch's gate must too:
    expect(gate(now, posted, perAccount)).toBe(false);
  });

  it('2175 deduction removed on recalculation, net pay up by it: must be a difference', () => {
    const posted = journalOf(plan(2_000, 500)); // CR 2175 500, CR bank 17300
    const now = plan(2_000, 0);                 // no 2175 line, CR bank 17800
    expect(gate(now, posted, perAccount)).toBe(false);
  });

  it('both PAYE and 2175 vanish into net pay at once: must be a difference', () => {
    const posted = journalOf(plan(2_000, 500));
    const now = plan(0, 0);
    expect(gate(now, posted, perAccount)).toBe(false);
  });
});
