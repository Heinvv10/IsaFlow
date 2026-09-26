/**
 * The payroll journal PLAN — the one description of what a pay run would post.
 *
 * This exists because `post_payroll_journal` needs a dry run that shows the
 * FULL journal, and the finding it was specified against is that only net pay
 * ever reaches the ledger. A preview that re-derived the journal separately
 * from the poster would be the fifth answer to a question that already has
 * four (docs/mcp/CONTRACTS.md §5), and would be free to disagree with what
 * actually posts — which is the one thing a dry run must never do. So the
 * poster and the preview share this builder, and these tests pin the shape
 * both of them see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);
const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/costCentreGlMappingService', () => ({
  getMappingLookup: vi.fn(async () => ({})),
}));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** A run whose statutory loads are all non-zero, so a builder that dropped one is visible. */
const HEADER = {
  id: RUN,
  company_id: COMPANY,
  period_month: 12,
  period_year: 2026,
  status: 'approved',
  journal_entry_id: null,
  total_gross: 100000,
  total_paye: 20000,
  total_uif: 2000, // combined employee + employer
  total_sdl: 1000,
  total_eti: 0,
  total_net: 76000, // 100000 − 20000 PAYE − 1000 employee UIF − 3000 other deductions
  employee_count: 4,
};

const ACCOUNTS = [
  { account_code: '5200', id: 'acc-5200', account_name: 'Labour Costs', is_active: true },
  { account_code: '2140', id: 'acc-2140', account_name: 'PAYE Payable', is_active: true },
  { account_code: '2150', id: 'acc-2150', account_name: 'UIF Payable', is_active: true },
  { account_code: '2160', id: 'acc-2160', account_name: 'SDL Payable', is_active: true },
  { account_code: '1110', id: 'acc-1110', account_name: 'Bank - Primary', is_active: true },
  { account_code: '2175', id: 'acc-2175', account_name: 'Other Employee Deductions Payable', is_active: true },
];

interface Route { match: string; rows: unknown[] }

function routeMock(routes: Route[]) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

function standardRoutes(overrides: Partial<Record<string, unknown[]>> = {}): Route[] {
  return [
    { match: 'payroll_run_headers', rows: overrides.header ?? [HEADER] },
    { match: 'FROM gl_accounts', rows: overrides.accounts ?? ACCOUNTS },
    { match: 'payroll_run_lines prl', rows: overrides.lines ?? [] },
    { match: 'payroll_employee_cost_allocations', rows: [] },
  ];
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('buildPayrollJournalPlan — the employment cost the ledger never sees', () => {
  it('debits labour with gross PLUS employer UIF PLUS SDL, not net pay', async () => {
    routeMock(standardRoutes());
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    // gross 100000 + employer UIF 1000 + SDL 1000 = 102000. The whole point of
    // the endpoint: this is R26,000 more than the R76,000 of net pay that is
    // all the ledger carries today.
    const labour = plan!.lines.filter((l) => l.debit > 0);
    expect(labour.reduce((s, l) => s + l.debit, 0)).toBeCloseTo(102000, 2);
    expect(plan!.totalDebit).toBeCloseTo(102000, 2);
  });

  it('raises every employer contribution as its own credit, each to its own account', async () => {
    routeMock(standardRoutes());
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const byCode = Object.fromEntries(plan!.lines.map((l) => [l.accountCode, l]));

    expect(byCode['2140']!.credit).toBeCloseTo(20000, 2); // PAYE
    expect(byCode['2150']!.credit).toBeCloseTo(2000, 2); // UIF, BOTH halves
    expect(byCode['2160']!.credit).toBeCloseTo(1000, 2); // SDL
    expect(byCode['1110']!.credit).toBeCloseTo(76000, 2); // net pay
    expect(byCode['2175']!.credit).toBeCloseTo(3000, 2); // other deductions residual
  });

  it('balances', async () => {
    routeMock(standardRoutes());
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.totalDebit).toBeCloseTo(plan!.totalCredit, 2);
    expect(plan!.blockers.map((b) => b.code)).not.toContain('unbalanced');
  });

  it('dates the entry on the last day of the period month, as a YYYY-MM-DD string', async () => {
    routeMock(standardRoutes());
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    // December on a UTC+2 host is where a toISOString() round-trip lands on
    // the 30th, or in the wrong year.
    expect(plan!.entryDate).toBe('2026-12-31');
  });

  it('dates February correctly in a leap year', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, period_month: 2, period_year: 2028 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.entryDate).toBe('2028-02-29');
  });
});

describe('buildPayrollJournalPlan — ETI offsets PAYE payable (K-079)', () => {
  // Hein, 2026-09-26: ETI is netted off labour cost and capped at the run's
  // PAYE. etiUsed = min(eti, paye); DR 5200 falls by etiUsed and CR 2140 is
  // paye − etiUsed, which is the EMP201 PAYE payable. Before K-079 the
  // labour debit fell by ETI while 2140 carried full PAYE, so every run with
  // ETI was unbalanced by exactly the ETI and could not post.
  const credit = (plan: Awaited<ReturnType<typeof buildPayrollJournalPlan>>, code: string) =>
    plan!.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.credit, 0);
  const debit = (plan: Awaited<ReturnType<typeof buildPayrollJournalPlan>>, code: string) =>
    plan!.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.debit, 0);

  it('ETI below PAYE: balances, credits 2140 net of ETI, and reduces labour by it', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, total_eti: 500 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers.map((b) => b.code)).not.toContain('unbalanced');
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
    expect(credit(plan, '2140')).toBe(19500);
    expect(debit(plan, '5200')).toBe(100000 + 1000 + 1000 - 500);
    expect(plan!.totals).toMatchObject({ eti: 500, etiUsed: 500 });
    expect(plan!.advisories.map((a) => a.code)).not.toContain('eti_beyond_paye');
  });

  it('ETI above PAYE: books only the ETI PAYE absorbs, drops the zero 2140 line, and says so', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, total_paye: 300, total_eti: 2500, total_net: 95700 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers).toEqual([]);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
    expect(plan!.lines.some((l) => l.accountCode === '2140')).toBe(false);
    expect(debit(plan, '5200')).toBe(100000 + 1000 + 1000 - 300);
    expect(plan!.totals).toMatchObject({ eti: 2500, etiUsed: 300 });
    const advisory = plan!.advisories.find((a) => a.code === 'eti_beyond_paye');
    expect(advisory?.detail).toContain('R2200.00');
  });

  it('ETI exactly equal to PAYE is fully booked and raises no advisory', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, total_eti: 20000 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.totals.etiUsed).toBe(20000);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
    expect(plan!.advisories.map((a) => a.code)).not.toContain('eti_beyond_paye');
  });

  it('no ETI: 2140 carries the full PAYE', async () => {
    routeMock(standardRoutes());
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(credit(plan, '2140')).toBe(20000);
    expect(plan!.totals.etiUsed).toBe(0);
  });

  it('drops a zero statutory line (SDL-exempt), which the GL would reject', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, total_sdl: 0 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.lines.some((l) => l.accountCode === '2160')).toBe(false);
    expect(plan!.lines.every((l) => l.debit !== 0 || l.credit !== 0)).toBe(true);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
  });
});

describe('buildPayrollJournalPlan — what would stop the post', () => {
  it('blocks a run that is not approved, naming the status it is in', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, status: 'calculated' }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const blocker = plan!.blockers.find((b) => b.code === 'run_not_approved');
    expect(blocker).toBeDefined();
    expect(blocker!.detail).toContain('calculated');
  });

  it('blocks a run that already carries a journal, and names it', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, journal_entry_id: 'je-1' }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('already_posted');
    expect(plan!.alreadyPostedJournalId).toBe('je-1');
  });

  it('blocks on a missing required account and NAMES the codes', async () => {
    routeMock(standardRoutes({ accounts: ACCOUNTS.filter((a) => a.account_code !== '2160') }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const blocker = plan!.blockers.find((b) => b.code === 'missing_gl_accounts');
    expect(blocker).toBeDefined();
    expect(blocker!.detail).toContain('2160');
  });

  it('blocks when voluntary deductions exist but account 2175 does not', async () => {
    routeMock(standardRoutes({ accounts: ACCOUNTS.filter((a) => a.account_code !== '2175') }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('missing_other_deductions_account');
  });
});

describe('buildPayrollJournalPlan — deactivated accounts are reported, never filtered', () => {
  it('still builds the journal into an inactive account and reports it as an advisory', async () => {
    // gl_accounts.is_active is a PICKER flag. Brightsphere carries all five
    // payroll accounts deactivated and Velocity Fibre carries 1110 deactivated;
    // the poster does not filter on is_active, so the money DOES land there.
    // Dropping the line would understate the journal; silence would hide that
    // the balance is parked where no human can pick it.
    routeMock(standardRoutes({
      accounts: ACCOUNTS.map((a) => (a.account_code === '1110' ? { ...a, is_active: false } : a)),
    }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.lines.find((l) => l.accountCode === '1110')!.credit).toBeCloseTo(76000, 2);
    expect(plan!.blockers.map((b) => b.code)).not.toContain('inactive_target_account');
    const advisory = plan!.advisories.find((a) => a.code === 'inactive_target_account');
    expect(advisory).toBeDefined();
    expect(advisory!.detail).toContain('1110');
  });

  it('never puts is_active in the account query — a mocked row set cannot catch that', async () => {
    // The two tests around this one feed rows straight past the WHERE clause,
    // so they stay green even if the query filtered the account out. This one
    // reads the SQL. `is_active` in a query that resolves where money lands is
    // the casewareExportService defect (R130,000 dropped) in a new place.
    routeMock(standardRoutes());
    await buildPayrollJournalPlan(COMPANY, RUN);
    const accountQuery = sqlCalls.find((c) => c.sql.includes('FROM gl_accounts'));
    expect(accountQuery!.sql).not.toMatch(/is_active\s*=/);
  });

  it('reports every inactive target account, not just the first', async () => {
    routeMock(standardRoutes({ accounts: ACCOUNTS.map((a) => ({ ...a, is_active: false })) }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const advisory = plan!.advisories.find((a) => a.code === 'inactive_target_account');
    for (const code of ['5200', '2140', '2150', '2160', '1110', '2175']) {
      expect(advisory!.detail).toContain(code);
    }
  });
});

describe('buildPayrollJournalPlan — tenant scope', () => {
  it('scopes the run header lookup by company and returns null for a run it does not own', async () => {
    routeMock(standardRoutes({ header: [] }));
    expect(await buildPayrollJournalPlan(COMPANY, RUN)).toBeNull();

    const headerQuery = sqlCalls.find((c) => c.sql.includes('payroll_run_headers'));
    expect(headerQuery!.values).toContain(COMPANY);
  });

  it('scopes the account lookup by company', async () => {
    routeMock(standardRoutes());
    await buildPayrollJournalPlan(COMPANY, RUN);
    const accountQuery = sqlCalls.find((c) => c.sql.includes('FROM gl_accounts'));
    expect(accountQuery!.values).toContain(COMPANY);
  });
});
