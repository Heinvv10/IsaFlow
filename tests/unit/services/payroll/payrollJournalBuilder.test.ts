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
import { getMappingLookup } from '@/modules/accounting/services/payroll/costCentreGlMappingService';

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

describe('buildPayrollJournalPlan — ETI through the cost-centre split (K-079)', () => {
  /** Run lines are read by the split; allocations first, because both queries name payroll_run_lines. */
  const splitRoutes = (header: Record<string, unknown>, lines: unknown[]): Route[] => [
    { match: 'payroll_employee_cost_allocations', rows: [] },
    { match: 'payroll_run_lines prl', rows: lines },
    ...standardRoutes({ header: [header] }),
  ];

  it('ties the split labour lines to the labour debit to the cent', async () => {
    // Three equal employees, R1 000 ETI on the header but none on the lines:
    // each share is 10 200 − 333.33 = 9 866.67, and 3 × that is 29 600.01.
    const header = { ...HEADER, total_gross: 30000, total_paye: 3000, total_uif: 600, total_sdl: 300,
      total_eti: 1000, total_net: 26700 };
    const lines = [1, 2, 3].map((n) => ({ employee_id: `e${n}`, gross_pay: 10000, eti: 0, cost_centre_id: null }));
    routeMock(splitRoutes(header, lines));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers).toEqual([]);
    expect(plan!.totalDebit).toBe(29600);
    expect(plan!.totalCredit).toBe(29600);
  });

  it('takes ETI off the labour cost of the employee who earned it, not by gross', async () => {
    // A (centre X → 5210) earns R4 000 and all R1 000 of ETI; B (centre Y → 5220) R36 000.
    // Cost before ETI 40 800 split by gross: A 4 080, B 36 720; A alone carries the ETI.
    vi.mocked(getMappingLookup).mockResolvedValueOnce({ X: 'acc-5210', Y: 'acc-5220' });
    const header = { ...HEADER, total_gross: 40000, total_paye: 8000, total_uif: 800, total_sdl: 400,
      total_eti: 1000, total_net: 31600 };
    const lines = [
      { employee_id: 'A', gross_pay: 4000, eti: 1000, cost_centre_id: 'X' },
      { employee_id: 'B', gross_pay: 36000, eti: 0, cost_centre_id: 'Y' },
    ];
    routeMock(splitRoutes(header, lines));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    const debitOn = (id: string) => plan!.lines.find((l) => l.glAccountId === id)?.debit;
    expect(debitOn('acc-5210')).toBe(3080);
    expect(debitOn('acc-5220')).toBe(36720);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
  });

  it('blocks a deactivated cost-centre labour account, as the GL poster would', async () => {
    vi.mocked(getMappingLookup).mockResolvedValueOnce({ X: 'acc-5210' });
    const header = { ...HEADER, total_gross: 40000, total_paye: 8000, total_uif: 800, total_sdl: 400,
      total_eti: 0, total_net: 31600 };
    const lines = [
      { employee_id: 'A', gross_pay: 4000, eti: 0, cost_centre_id: 'X' },
      { employee_id: 'B', gross_pay: 36000, eti: 0, cost_centre_id: null },
    ];
    routeMock([
      { match: 'id = ANY', rows: [{ id: 'acc-5210', account_code: '5210', account_name: 'Site labour', is_active: false }] },
      ...splitRoutes(header, lines),
    ]);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.lines.find((l) => l.glAccountId === 'acc-5210')).toMatchObject({ accountCode: '5210', inactiveAccount: true });
    expect(plan!.blockers.find((b) => b.code === 'inactive_target_account')?.detail).toContain('5210');
    const scoped = sqlCalls.find((c) => c.sql.includes('id = ANY'));
    expect(scoped!.values).toContain(COMPANY);
  });
});

describe('buildPayrollJournalPlan — what would stop the post', () => {
  it('blocks a negative amount, which a journal line cannot carry', async () => {
    // Net pay above gross − PAYE − employee UIF: the residual deductions line
    // is skipped and nothing balances — but a negative 1110 must be named.
    routeMock(standardRoutes({ header: [{ ...HEADER, total_net: -500 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.find((b) => b.code === 'negative_amount')?.detail).toContain('1110');
  });

  it('an odd-cent UIF total still balances: the two halves sum to it exactly', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, total_uif: 2000.01 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers).toEqual([]);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
  });

  it('blocks a 1-cent imbalance — the GL rejects it, so the plan must too', async () => {
    // Net pay one cent above the residual: other deductions come to −0.01,
    // are skipped, and credits exceed debits by R0.01.
    routeMock(standardRoutes({ header: [{ ...HEADER, total_net: 79000.01 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('unbalanced');
  });

  it('blocks a run whose period is closed, naming the status (the GL poster refuses it)', async () => {
    routeMock([{ match: 'FROM fiscal_periods', rows: [{ status: 'closed' }] }, ...standardRoutes()]);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const blocker = plan!.blockers.find((b) => b.code === 'closed_period');
    expect(blocker?.detail).toContain("'closed'");
    expect(blocker?.detail).toContain('2026-12-31');
  });

  it('does not block an open period', async () => {
    routeMock([{ match: 'FROM fiscal_periods', rows: [{ status: 'open' }] }, ...standardRoutes()]);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers).toEqual([]);
  });

  it('blocks a run with nothing to post (every line zero)', async () => {
    routeMock(standardRoutes({ header: [{ ...HEADER, total_gross: 0, total_paye: 0, total_uif: 0, total_sdl: 0, total_net: 0 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.lines).toEqual([]);
    expect(plan!.blockers.map((b) => b.code)).toContain('nothing_to_post');
  });

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

describe('buildPayrollJournalPlan — deactivated accounts block the post, and the line is still built', () => {
  it('builds the journal into an inactive account and BLOCKS it, naming the account', async () => {
    // Brightsphere carries all five payroll accounts deactivated and Velocity
    // Fibre 1110. The line is kept (dropping it would understate the journal),
    // but postJournalEntry refuses a deactivated account, so the plan must too —
    // an advisory here greenlit a dry run the live post refused (K-079 review).
    routeMock(standardRoutes({
      accounts: ACCOUNTS.map((a) => (a.account_code === '1110' ? { ...a, is_active: false } : a)),
    }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.lines.find((l) => l.accountCode === '1110')!.credit).toBeCloseTo(76000, 2);
    const blocker = plan!.blockers.find((b) => b.code === 'inactive_target_account');
    expect(blocker!.detail).toContain('1110');
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

  it('names every inactive target account, not just the first', async () => {
    routeMock(standardRoutes({ accounts: ACCOUNTS.map((a) => ({ ...a, is_active: false })) }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const blocker = plan!.blockers.find((b) => b.code === 'inactive_target_account');
    for (const code of ['5200', '2140', '2150', '2160', '1110', '2175']) {
      expect(blocker!.detail).toContain(code);
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
