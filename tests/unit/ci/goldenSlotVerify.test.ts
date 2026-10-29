// What a slot must hold before the golden suite can run in it: the same preconditions _global-setup.ts and the
// specs check, as a pure judgement over counts so the provisioner can refuse to commit an unusable slot.
import { describe, expect, it } from 'vitest';
import { SEED } from '../../../scripts/ci/golden/seedSlotData';
import type { ClientBase } from 'pg';
import { REQUIRED_SYSTEM_SUBTYPES, readSlotReport, seedProblems, slotProblems, slotWarnings, type SlotReport } from '../../../scripts/ci/golden/slotVerify';

const good: SlotReport = {
  companyId: '601d0000-0000-4000-8000-000000000001',
  systemAccounts: Object.fromEntries(REQUIRED_SYSTEM_SUBTYPES.map((s) => [s, 1])),
  employees: 11,
  bankAccounts: 6,
  open2027Periods: 12,
  sandboxPeriodOpen: true,
  payrollRunsInSandboxMonth: 0,
  members: 1,
  seededInvoices: SEED.invoices,
  seededJournals: SEED.journals,
  seededBankRows: SEED.bankRows,
  migrationSessions: 1,
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
    ['two members in a new slot (it is one golden user)', { members: 2 }, 'member'],
  ])('refuses %s', (_label, patch, word) => {
    const problems = slotProblems({ ...good, ...patch }, true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(word);
  });

  it('accepts the reopened payroll run a used slot keeps in the sandbox month, so a re-provision does not fail', () => {
    expect(slotProblems({ ...good, payrollRunsInSandboxMonth: 1 }, false)).toEqual([]);
  });

  it('a re-run only warns about an extra member of a slot that exists, and still fails when nobody can log in', () => {
    expect(slotProblems({ ...good, members: 2 }, false)).toEqual([]);
    expect(slotWarnings({ ...good, members: 2 }, false)).toEqual([expect.stringContaining('2 members')]);
    expect(slotWarnings({ ...good, members: 2 }, true)).toEqual([]);
    expect(slotWarnings(good, false)).toEqual([]);
    expect(slotProblems({ ...good, members: 0 }, false)).toEqual([expect.stringContaining('no member')]);
  });
});

describe('seedProblems', () => {
  it('is empty for a fully seeded slot, and a slot that has since grown past the seed', () => {
    expect(seedProblems(good)).toEqual([]);
    expect(seedProblems({ ...good, seededInvoices: SEED.invoices + 40, seededJournals: SEED.journals + 5, migrationSessions: 2 })).toEqual([]);
  });

  it('flags a bare slot (a fresh clone of Demo) on every count', () => {
    const bare = { ...good, seededInvoices: 0, seededJournals: 0, seededBankRows: 0, migrationSessions: 0 };
    expect(seedProblems(bare)).toEqual([
      expect.stringContaining('supplier invoices'), expect.stringContaining('journals'), expect.stringContaining('bank rows'), expect.stringContaining('migration session'),
    ]);
  });

  it.each([
    ['one invoice short', { seededInvoices: SEED.invoices - 1 }, 'supplier invoices'],
    ['one journal short', { seededJournals: SEED.journals - 1 }, 'journals'],
    ['one bank row short', { seededBankRows: SEED.bankRows - 1 }, 'bank rows'],
    ['no migration session', { migrationSessions: 0 }, 'migration session'],
  ])('flags %s and nothing else', (_label, patch, word) => {
    const problems = seedProblems({ ...good, ...patch });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(word);
  });

  it('is kept out of slotProblems: a company created this run is seeded only after its commit', () => {
    expect(slotProblems({ ...good, seededInvoices: 0, seededJournals: 0, seededBankRows: 0, migrationSessions: 0 }, true)).toEqual([]);
  });
});

describe('readSlotReport binds its dates and sandbox month', () => {
  const COMPANY = '601d0000-0000-4000-8000-000000000002';
  async function readWithRecording() {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const db = {
      query: async (text: string, params: unknown[] = []) => {
        seen.push({ text, params });
        return { rows: text.includes('GROUP BY') ? [] : [{ n: '1' }] };
      },
    } as unknown as ClientBase;
    await readSlotReport(db, COMPANY);
    return seen;
  }

  it('has no date or sandbox-month literal in any statement', async () => {
    for (const { text } of await readWithRecording()) {
      expect(text, text).not.toMatch(/20\d\d-\d\d-\d\d/);
      expect(text, text).not.toMatch(/period_(year|month)\s*=\s*\d/);
    }
  });

  it('passes the company first, then the sandbox year, month and the 2027 dates as parameters', async () => {
    const seen = await readWithRecording();
    const periods = seen.find((s) => /status = 'open' AND start_date >= \$2::date AND start_date < \$3::date/.test(s.text))!;
    expect(periods.params).toEqual([COMPANY, '2027-01-01', '2028-01-01']);
    const sandbox = seen.find((s) => /start_date <= \$3::date AND end_date >= \$2::date/.test(s.text))!;
    expect(sandbox.params).toEqual([COMPANY, '2027-02-01', '2027-02-28']);
    const runs = seen.find((s) => /FROM payroll_run_headers/.test(s.text))!;
    expect(runs.params).toEqual([COMPANY, 2027, 2]);
    expect(seen.every((s) => s.params[0] === COMPANY)).toBe(true);
  });
});
