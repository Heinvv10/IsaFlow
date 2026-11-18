/**
 * Wave 6 FQc, review #1575 (payroll breaker B1-B7 and round 2 G1-G5, rulings H1-H2, M1-M3, M5) on real Postgres, two tenants where it
 * matters. Each case drops the per-month unique in its own transaction and rolls back (w6-fqb1.helpers twoRunsInMonth;
 * FQx, migration 999p, drops it for good after FQc merges). The FQa run-kind guard is stubbed until FQd lifts its
 * frequency clause; payrollFrequencyGuard and the gates run for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedTenant, twoRunsInMonth, type Tenant } from './w6-fqb1.helpers';
import { WEEKS, approve, line, seedWeekly, weeklyRun, type Line } from './w6-fqc.helpers';

vi.mock('@/modules/accounting/services/payroll/payrollRunKindGuard', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/payroll/payrollRunKindGuard')>(),
  assertRunKindSupported: vi.fn(async () => undefined),
}));

import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { judgeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDateGate';
import { monthOrderRefusal } from '@/modules/accounting/services/payroll/payrollMonthOrderGate';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';
import { calculatePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import type { McpToolContext } from '@/lib/mcp/types';
import { loadLineCadences } from '@/modules/accounting/services/payroll/payrollRunCadence';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { applyPackageToEmployee, createPayPackage, setPackageComponents } from '@/modules/accounting/services/payroll/payPackageService';
import { createBatch, addBatchLines, validateBatch } from '@/modules/accounting/services/payroll/payrollBatchService';
import { postBatch } from '@/modules/accounting/services/payroll/payrollBatchPost';
import { setRunPeriodAmount } from '@/modules/accounting/services/payroll/payrollRunPeriodInputs';
import { changeAssignmentDates } from '@/modules/accounting/services/payroll/payrollComponentDateEdit';
import { EmployeeComponentRefused } from '@/modules/accounting/services/payroll/payrollEmployeeComponentRefused';
import { PayrollRunInputRefusedError } from '@/modules/accounting/services/payroll/payrollRunInputRefused';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;
let c: PoolClient;

const sumUif = (ls: Line[]) => Math.round(ls.reduce((t, l) => t + l.uif, 0) * 100) / 100;
const CEILING_UIF = 177.12; // 1% of the R17 712 monthly ceiling
const gate = async (runId: string) => (await judgeYearToDate(A.company, runId)).blocker?.code ?? null;
const reopen = (runId: string) => c.query(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL WHERE id = $1`, [runId]);

beforeAll(async () => { A = await seedTenant(pool, 'W6 FQc rev1575 A'); B = await seedTenant(pool, 'W6 FQc rev1575 B'); });
afterAll(async () => { try { await dropTenants(pool, [A, B]); } finally { await pool.end(); } });

describe('H1: pay order inside one EMP201 month', () => {
  it('B1 (a): week 4 is refused while week 3 is open; approved in order, June UIF stays under the ceiling and ETI is claimed once', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      await seedWeekly(c, B);
      const other = await weeklyRun(c, B, WEEKS[2]); // another tenant's open run never blocks this one
      await calculatePayrollRun(other, B.company);
      const ids: string[] = [];
      for (const week of WEEKS) ids.push(await weeklyRun(c, A, week));
      for (const id of ids.slice(0, 2)) { await calculatePayrollRun(id, A.company); await approve(c, id); }
      await calculatePayrollRun(ids[2]!, A.company); // week 3 calculated, left open
      await calculatePayrollRun(ids[3]!, A.company);
      const week4Refused = await gate(ids[3]!);
      const week3 = await gate(ids[2]!);
      await approve(c, ids[2]!);
      await calculatePayrollRun(ids[3]!, A.company);
      const week4 = await gate(ids[3]!);
      await approve(c, ids[3]!);
      return {
        week4Refused, week3, week4,
        big: await Promise.all(ids.map((r) => line(c, r, a.big))), young: await Promise.all(ids.map((r) => line(c, r, a.young))),
      };
    });
    expect([got.week4Refused, got.week3, got.week4]).toEqual(['pay_order_in_month', null, null]);
    expect(got.big.map((l) => l.uif)).toEqual([60, 60, 57.12, 0]);
    expect(got.young.filter((l) => l.eti > 0)).toHaveLength(1);
  });

  it('B2 (b): week 2 reopened with R6 000 more is refused while weeks 3-4 stand; reopened and recalculated in order, UIF and ETI follow', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      const ids: string[] = [];
      for (const week of WEEKS) { const id = await weeklyRun(c, A, week); await calculatePayrollRun(id, A.company); await approve(c, id); ids.push(id); }
      await reopen(ids[1]!);
      await c.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
                     VALUES ($1, $3, 6000, '2026-06-10', '2026-06-10', false), ($2, $3, 6000, '2026-06-10', '2026-06-10', false)`, [a.young, a.big, a.extra]);
      await calculatePayrollRun(ids[1]!, A.company);
      const refused = await gate(ids[1]!); // the PAYE_LATER_PERIODS_APPROVED warning on the line does not clear it
      for (const id of ids.slice(2)) await reopen(id);
      const week2 = await gate(ids[1]!);
      await approve(c, ids[1]!);
      for (const id of ids.slice(2)) { await calculatePayrollRun(id, A.company); await approve(c, id); }
      const emp201 = await generateEMP201(A.company, '2026-06-01', '2026-06-30');
      return {
        refused, week2, emp201eti: emp201.totalETI,
        big: await Promise.all(ids.map((r) => line(c, r, a.big))), young: await Promise.all(ids.map((r) => line(c, r, a.young))),
      };
    });
    expect([got.refused, got.week2]).toEqual(['pay_order_in_month', null]);
    expect(sumUif(got.big)).toBe(CEILING_UIF);
    // June remuneration R12 500 is above R7 500: no ETI for June (ETI Act s7, the April 2025 table).
    expect(got.young.reduce((t, l) => t + l.eti, 0)).toBe(0);
    expect(got.emp201eti).toBe(0);
  });
});

describe('H2 and M1: off-cycle runs', () => {
  it('B3/B4/B5: an off-cycle run at a weekly frequency is refused at calculate (off-cycle is monthly only)', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await seedWeekly(c, A);
      const bonus = String((await c.query(
        `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, pay_frequency, run_kind, off_cycle_reason, run_date, period_start, period_end)
         VALUES ($1, 6, 2026, 'draft', 'weekly', 'off_cycle', 'bonus', '2026-06-26', '2026-06-20', '2026-06-26') RETURNING id`, [A.company])).rows[0].id);
      return calculatePayrollRun(bonus, A.company).then(() => null, (e: unknown) => e as { code?: string; status?: number });
    });
    expect(got).toMatchObject({ code: 'PAY_FREQUENCY_REFUSED', status: 400 });
  });

  it('H2: only a regular run closes the ETI month; an off-cycle run on the closing pay date leaves its line pending', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      const run = await weeklyRun(c, A, WEEKS[3]);
      const period = { year: 2026, month: 6, start: WEEKS[3][0], end: WEEKS[3][1] };
      const employees = [{ id: a.young, endDate: null }];
      const regular = await loadLineCadences(A.company, run, { frequency: 'weekly', period, runDate: null, runKind: 'regular' }, employees);
      const offCycle = await loadLineCadences(A.company, run, { frequency: 'weekly', period, runDate: null, runKind: 'off_cycle' }, employees);
      return { regular: regular.get(a.young)?.etiMonthToDate, offCycle: offCycle.get(a.young)?.etiMonthToDate };
    });
    expect(got.regular).not.toBeNull();
    expect(got.offCycle).toBeNull();
  });
});

describe('M2: the year to date counts the period share each line was costed with', () => {
  it('B6: a start date edited after three paid weeks leaves n at 3', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      for (const week of WEEKS.slice(0, 3)) { const id = await weeklyRun(c, A, week); await calculatePayrollRun(id, A.company); await approve(c, id); }
      await c.query(`UPDATE payroll_employees SET start_date = '2026-06-20' WHERE id = $1`, [a.big]);
      const w4 = await weeklyRun(c, A, WEEKS[3]);
      const y = (await loadPayeYearToDate(A.company, w4, { year: 2026, month: 6 }, [a.big])).get(a.big);
      await calculatePayrollRun(w4, A.company);
      return { periods: y?.periods, taxable: y?.periodicTaxable, w4: (await line(c, w4, a.big)).paye };
    });
    expect([got.periods, got.taxable]).toEqual([3, 18000]);
    expect(got.w4).toBe(840.23); // (tax(312 000) - 17 820) / 52, as the three weeks before it
  });
});

describe('M3: a leaver\'s last run of the month closes ETI for them', () => {
  it('B7: leaving 12 June, week 2 claims June ETI on weeks 1-2', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      await c.query(`UPDATE payroll_employees SET end_date = '2026-06-12' WHERE id = $1`, [a.young]);
      for (const week of WEEKS) { const id = await weeklyRun(c, A, week); await calculatePayrollRun(id, A.company); await approve(c, id); }
      return (await c.query(`SELECT l.eti::float8 AS eti, l.validation_results @> '[{"code":"ETI_MONTH_PENDING"}]'::jsonb AS pending
                               FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
                              WHERE l.employee_id = $1 ORDER BY h.period_start`, [a.young])).rows as Array<{ eti: number; pending: boolean }>;
    });
    expect(got.map((r) => r.pending)).toEqual([true, false]);
    // Weeks 1-2 paid R3 000 in June (April 2025 table: R2 500 to R5 500 is R1 500), scaled to the hours employed in June.
    expect(got[1]!.eti).toBeGreaterThan(0);
  });
});

describe('M5: every assignment writer refuses a 38xx or 3701 row for a weekly employee', () => {
  const fringe = (t: Tenant) => c.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type) VALUES ($1, 'Medical (employer)', '3810', 'earning') RETURNING id`,
    [t.company]).then((r) => String(r.rows[0].id));
  const refusedWith = (p: Promise<unknown>) => p.then(() => 'written', (e: unknown) => (e as Error).constructor.name + ': ' + (e as Error).message);

  it('package apply, batch post and an edit of dates refuse it, the pay-run grid never takes one, ending such a row is allowed', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      const medical = await fringe(A);
      const pkg = await createPayPackage({ companyId: A.company, code: 'FQC', name: 'FQc package', userId: A.user });
      await setPackageComponents(A.company, pkg.id, [{ componentId: medical, amount: 500, isRecurring: true }]);
      const pack = await refusedWith(applyPackageToEmployee(A.company, pkg.id, a.young, '2026-06-01', A.user));
      const batch = await createBatch({ companyId: A.company, batchType: 'component_values', componentId: medical, description: 'FQc',
        periodYear: 2026, periodMonth: 6, isRecurring: true, userId: A.user });
      await addBatchLines(A.company, batch.id, [{ employeeId: a.young, value: 500, effectiveFrom: new Date('2026-06-01T00:00:00Z') }]);
      await validateBatch(A.company, batch.id);
      const post = await refusedWith(postBatch(A.company, batch.id, A.user));
      const run = await weeklyRun(c, A, WEEKS[0]);
      await calculatePayrollRun(run, A.company);
      const grid = await refusedWith(setRunPeriodAmount(A.company, run, a.young, medical, 500, 0, { userId: A.user, channel: 'rest' } as never));
      const row = String((await c.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
                                         VALUES ($1, $2, 500, '2026-01-01') RETURNING id`, [a.young, medical])).rows[0].id);
      const edit = await refusedWith(changeAssignmentDates(A.company, row, { kind: 'edit', from: '2026-02-01', to: null }, { userId: A.user, channel: 'rest' } as never));
      const end = await refusedWith(changeAssignmentDates(A.company, row, { kind: 'end', to: '2026-05-31' }, { userId: A.user, channel: 'rest' } as never));
      return { pack, post, grid, edit, end };
    });
    expect(got.pack).toMatch(new RegExp(`^${EmployeeComponentRefused.name}: .*FQC-YOUNG.*weekly`));
    expect(got.post).toMatch(new RegExp(`^${EmployeeComponentRefused.name}: .*FQC-YOUNG.*weekly`));
    // The grid edits only 3601/3606/3607 earnings (isEditableRunComponent), so a 38xx never reaches its write guard; the
    // frequency refusal in refuseAssignmentWrite (which the grid's insert calls) is proven by the package and batch paths.
    expect(got.grid).toMatch(new RegExp(`^${PayrollRunInputRefusedError.name}: This component cannot be edited on a pay run`));
    expect(got.edit).toMatch(new RegExp(`^${EmployeeComponentRefused.name}: .*weekly`));
    expect(got.end).toBe('written');
  });
});

const realReopen = (t: Tenant, runId: string) => reopenPayrollRun({ runId, companyId: t.company, userId: t.user, reason: 'review r2 reopen' });

async function monthlySalary(t: Tenant, amount: number) {
  const comp = String((await c.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type) VALUES ($1, 'Basic', '3601', 'earning') RETURNING id`, [t.company])).rows[0].id);
  await c.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')`, [t.employee, comp, amount]);
  for (const [code, type] of [['5200', 'expense'], ['1110', 'asset'], ['2140', 'liability'], ['2150', 'liability'], ['2160', 'liability'], ['2175', 'liability']] as const) {
    await c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7) ON CONFLICT DO NOTHING`, [t.company, code, `r2 ${code}`, type, type === 'liability' ? 'credit' : 'debit', code === '1110' ? 'bank' : null, code === '1110']);
  }
}
const monthlyRun = async (t: Tenant, month: number, extra: { offCycle?: string; runDate?: string } = {}) => String((await c.query(
  `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, pay_frequency, run_kind, off_cycle_reason, run_date, period_start, period_end)
   VALUES ($1, $2, 2026, 'draft', 'monthly', $3, $4, $5::date, make_date(2026, $2, 1), (make_date(2026, $2, 1) + interval '1 month - 1 day')::date) RETURNING id`,
  [t.company, month, extra.offCycle ? 'off_cycle' : 'regular', extra.offCycle ?? null, extra.runDate ?? null])).rows[0].id);

describe('round 2 (G1-G5): the month-order gate', () => {
  it('G1 a stray DRAFT run of the month, never calculated, blocks no week', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await seedWeekly(c, A);
      const ids: string[] = [];
      for (const week of WEEKS) ids.push(await weeklyRun(c, A, week));
      // A mis-keyed week (Sunday start) created by mistake and left as a draft: no lines, nobody on it.
      const stray = await weeklyRun(c, A, ['2026-05-31', '2026-06-06']);
      const gates: Array<string | null> = [];
      for (const id of ids) { await calculatePayrollRun(id, A.company); gates.push(await gate(id)); if (gates.at(-1) === null) await approve(c, id); }
      const strayLines = Number((await c.query('SELECT count(*) FROM payroll_run_lines WHERE run_id = $1', [stray])).rows[0].count);
      return { gates, strayLines };
    });
    expect(got.gates).toEqual([null, null, null, null]);
    expect(got.strayLines).toBe(0);
  });

  it('G6 the stray overlapping weeks 1-2 is refused at calculate (409 PAY_PERIOD_OVERLAP, naming both runs), in the MCP dry run too; June pays four weeks', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      await seedWeekly(c, B);
      for (const week of WEEKS) await weeklyRun(c, B, week); // another tenant's identical weeks never overlap A's
      for (const week of WEEKS) { const id = await weeklyRun(c, A, week); await calculatePayrollRun(id, A.company); await approve(c, id); }
      const stray = await weeklyRun(c, A, ['2026-05-31', '2026-06-06']);
      const calc = await calculatePayrollRun(stray, A.company).then(() => null, (e: unknown) => e as { code?: string; status?: number; message: string });
      const ctx = { companyId: A.company, userId: A.user, scopes: ['write:payroll'], tokenJti: null, oauthAppId: null, role: 'admin' } as McpToolContext;
      const dry = await calculatePayRunTool.handler({ run_id: stray, dry_run: true, idempotency_key: crypto.randomUUID() }, ctx);
      const strayLines = Number((await c.query('SELECT count(*) FROM payroll_run_lines WHERE run_id = $1', [stray])).rows[0].count);
      const gross = Number((await c.query(`SELECT COALESCE(SUM(l.gross_pay), 0)::float8 AS g FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
                                            WHERE l.employee_id = $1 AND h.status = 'approved'`, [a.big])).rows[0].g);
      return { calc, dry: JSON.stringify(dry), strayLines, gross };
    });
    expect(got.calc).toMatchObject({ code: 'PAY_PERIOD_OVERLAP', status: 409 });
    expect(got.calc?.message).toContain('2026-05-30 to 2026-06-05');
    expect(got.calc?.message).toContain('2026-06-06 to 2026-06-12');
    expect(got.dry).toContain('overlap');
    expect(got.dry).toContain('2026-05-30 to 2026-06-05');
    expect(got.strayLines).toBe(0);
    expect(got.gross).toBe(24000);
  });

  it('G2 two tenants: A\'s open week 1 does not block B\'s week 2', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await seedWeekly(c, A); await seedWeekly(c, B);
      await weeklyRun(c, A, WEEKS[0]);
      const b1 = await weeklyRun(c, B, WEEKS[0]); await calculatePayrollRun(b1, B.company); await approve(c, b1);
      const b2 = await weeklyRun(c, B, WEEKS[1]); await calculatePayrollRun(b2, B.company);
      return (await judgeYearToDate(B.company, b2)).blocker?.code ?? null;
    });
    expect(got).toBeNull();
  });

  it('G3 a monthly company: May reopened (real reopen) and recalculated after June: the in-month gate is silent', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await monthlySalary(A, 20000);
      const may = await monthlyRun(A, 5); await calculatePayrollRun(may, A.company); await approve(c, may);
      const jun = await monthlyRun(A, 6); await calculatePayrollRun(jun, A.company); await approve(c, jun);
      await realReopen(A, may);
      const inMonthReopenedOnly = await monthOrderRefusal(A.company, may);
      await calculatePayrollRun(may, A.company);
      return { inMonth: (await monthOrderRefusal(A.company, may))?.code ?? null, inMonthBefore: inMonthReopenedOnly?.code ?? null, whole: await gate(may) };
    }, { keepMonthKey: true });
    expect(got.inMonth).toBeNull();
  });

  it('G4 weekly: week 2 reopened by the real reopen and re-approved WITHOUT a recalculation passes (b)', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await seedWeekly(c, A);
      const ids: string[] = [];
      for (const week of WEEKS) { const id = await weeklyRun(c, A, week); await calculatePayrollRun(id, A.company); await approve(c, id); ids.push(id); }
      await realReopen(A, ids[1]!);
      const hist = (await c.query('SELECT approval_history::text AS h, status FROM payroll_run_headers WHERE id = $1', [ids[1]])).rows[0];
      return { hist, gate: await gate(ids[1]!) };
    });
    expect(got.gate).toBeNull();
  });

  it('G5 monthly runs are not judged in-month: regular 25 May and bonus 30 May approved, the regular reopened and recalculated, passes as on master', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await monthlySalary(A, 20000);
      const reg = await monthlyRun(A, 5, { runDate: '2026-05-25' }); await calculatePayrollRun(reg, A.company); await approve(c, reg);
      const bonus = await monthlyRun(A, 5, { offCycle: 'bonus', runDate: '2026-05-30' });
      const err = await calculatePayrollRun(bonus, A.company).then(() => null, (e: Error) => e.message);
      await approve(c, bonus);
      await realReopen(A, reg);
      await calculatePayrollRun(reg, A.company);
      return { err, inMonth: (await monthOrderRefusal(A.company, reg))?.code ?? null, whole: await gate(reg) };
    });
    expect(got.inMonth).toBeNull();
    // Master's gate: the bonus is not a later month, and here the warning naming the bonus clears it: null either way.
    expect(got.whole).toBeNull();
  });
});
