/**
 * K-079 — the payroll journal plan under ETI, and the GL poster's refusals
 * named as plan blockers. Split from payrollJournalBuilder.test.ts (300-line
 * cap); same mocks and fixtures.
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

  it('does NOT absorb a gap between the run lines and the header — the plan refuses it', async () => {
    // Header gross 30 000 but the lines carry 20 000: a third of the labour
    // debit has no employee. Tying it onto one cost centre would hide it.
    const header = { ...HEADER, total_gross: 30000, total_paye: 3000, total_uif: 600, total_sdl: 300,
      total_eti: 0, total_net: 26700 };
    const lines = [1, 2].map((n) => ({ employee_id: `e${n}`, gross_pay: 10000, eti: 0, cost_centre_id: null }));
    routeMock(splitRoutes(header, lines));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers.map((b) => b.code)).toContain('unbalanced');
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

describe('buildPayrollJournalPlan — the GL poster\'s refusals are plan blockers (K-079)', () => {
  it('blocks a negative amount, which a journal line cannot carry', async () => {
    // Net pay above gross − PAYE − employee UIF: the residual deductions line
    // is skipped and nothing balances — but a negative 1110 must be named.
    routeMock(standardRoutes({ header: [{ ...HEADER, total_net: -500 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.find((b) => b.code === 'negative_amount')?.detail).toContain('1110');
  });

  it('a negative PAYE total books no ETI and is refused as a negative amount', async () => {
    // Only an imported or hand-edited header can carry this; the engine floors PAYE at 0.
    routeMock(standardRoutes({ header: [{ ...HEADER, total_paye: -100 }] }));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.totals.etiUsed).toBe(0);
    expect(plan!.blockers.find((b) => b.code === 'negative_amount')?.detail).toContain('2140');
    expect(plan!.advisories.map((a) => a.code)).not.toContain('eti_beyond_paye');
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
});
