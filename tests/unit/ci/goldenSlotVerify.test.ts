// What a slot must hold before the golden suite can run in it: the same preconditions _global-setup.ts and the
// specs check, as a pure judgement over counts so the provisioner can refuse to commit an unusable slot.
import { describe, expect, it } from 'vitest';
import { REQUIRED_SYSTEM_SUBTYPES, slotProblems, type SlotReport } from '../../../scripts/ci/golden/slotVerify';

const good: SlotReport = {
  companyId: '601d0000-0000-4000-8000-000000000001',
  systemAccounts: Object.fromEntries(REQUIRED_SYSTEM_SUBTYPES.map((s) => [s, 1])),
  employees: 11,
  bankAccounts: 6,
  open2027Periods: 12,
  sandboxPeriodOpen: true,
  payrollRunsInSandboxMonth: 0,
  members: 1,
};

describe('slotProblems', () => {
  it('is empty for a usable slot', () => {
    expect(slotProblems(good, true)).toEqual([]);
    expect(slotProblems(good, false)).toEqual([]);
  });

  it('names a missing system account', () => {
    expect(slotProblems({ ...good, systemAccounts: { ...good.systemAccounts, vat_output: 0 } }, true)).toEqual([expect.stringContaining('vat_output')]);
  });

  it.each([
    ['no employees (the payroll spec)', { employees: 0 }, 'employees'],
    ['no bank account (the bank import spec)', { bankAccounts: 0 }, 'bank account'],
    ['no open 2027 period besides the sandbox month', { open2027Periods: 1 }, '2027'],
    ['the payroll sandbox month closed', { sandboxPeriodOpen: false }, '2027-02'],
    ['a payroll run already in the sandbox month of a fresh slot (the spec reserves it, it must start empty)', { payrollRunsInSandboxMonth: 1 }, 'payroll run'],
    ['no member (nobody could log in)', { members: 0 }, 'member'],
    ['two members (the slot is one golden user)', { members: 2 }, 'member'],
  ])('refuses %s', (_label, patch, word) => {
    const problems = slotProblems({ ...good, ...patch }, true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(word);
  });

  it('accepts the reopened payroll run a used slot keeps in the sandbox month, so a re-provision does not fail', () => {
    expect(slotProblems({ ...good, payrollRunsInSandboxMonth: 1 }, false)).toEqual([]);
  });
});
