/**
 * Wave 6 FQb1: the run-keyed READERS (census class R, owner FQb1), each with two runs in one month: a regular run and
 * an off-cycle bonus run of the same calendar month (the shape FQx allows), the per-month unique dropped inside the
 * case's own rolled-back transaction (w6-fqb1.helpers.ts). Company B holds the same shape at 10x, so a reader that
 * leaked across tenants moves A's figure. Seed order puts the run a reader must NOT pick first, so a reader that
 * still leans on the per-month unique takes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedRun, seedTenant, twoRunsInMonth, type RunSpec, type Tenant } from './w6-fqb1.helpers';
import { emp201PayeByMonth } from '@/modules/accounting/services/payroll/payrollEmp201Paye';
import { readYearEndStatusRows } from '@/modules/accounting/services/payroll/yearEndStatusReads';
import { latestPayrollRun } from '@/modules/accounting/services/payroll/payrollRunHeaders';
import { readEmployeeReadiness } from '@/modules/accounting/services/payroll/employeeReadinessRead';
import { getDeclarablePayRun } from '@/modules/accounting/services/payroll/payrollRunQueryService';
import { loadMedicalRecord } from '@/modules/accounting/services/payroll/payrollMedicalRecord';
import { getParallelRunReport } from '@/modules/accounting/services/payroll/payrollParallelRunReportService';
import { getPayrollRunVariance } from '@/modules/accounting/services/payroll/payrollVarianceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;

/** May 2026 (tax year 2027): the regular run paid on the 25th, the off-cycle bonus on the 28th. */
const REGULAR: RunSpec = { year: 2026, month: 5, runDate: '2026-05-25', gross: 20000, paye: 2000 };
const BONUS: RunSpec = { year: 2026, month: 5, runDate: '2026-05-28', offCycle: true, gross: 5000, paye: 700 };
const x10 = (r: RunSpec): RunSpec => ({ ...r, gross: (r.gross ?? 10000) * 10, paye: (r.paye ?? 1000) * 10 });

/** B's runs (10x), then A's in the order given: the first is the one a month-keyed reader would take. */
async function seedBoth(c: PoolClient, aRuns: RunSpec[]): Promise<string[]> {
  for (const r of aRuns) await seedRun(c, B, x10(r));
  const ids: string[] = [];
  for (const r of aRuns) ids.push(await seedRun(c, A, r));
  return ids;
}

beforeAll(async () => {
  A = await seedTenant(pool, 'W6 FQb1 reads A');
  B = await seedTenant(pool, 'W6 FQb1 reads B');
});

afterAll(async () => {
  try { await dropTenants(pool, [A, B]); } finally { await pool.end(); }
});

describe('EMP201 PAYE per month (EMP501 reconciliation, year-end status)', () => {
  it('sums both runs of the month; B is not in it', async () => {
    const [byMonth, yearEnd] = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, [BONUS, REGULAR]); },
      async () => [await emp201PayeByMonth(A.company, 2027), await readYearEndStatusRows(A.company, 2027)] as const);
    expect(byMonth.get('2026-5')).toBe(2700);
    expect([...byMonth.keys()]).toEqual(['2026-5']);
    expect(yearEnd.headerRows.map((r) => [Number(r.period_year), Number(r.period_month), Number(r.emp201_paye)])).toEqual([[2026, 5, 2700]]);
  });
});

describe('"the latest run" readers take the later run of the month', () => {
  it('latestPayrollRun (period context): the bonus paid on the 28th', async () => {
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => { [, bonus] = await seedBoth(c, [REGULAR, BONUS]); },
      () => latestPayrollRun(A.company));
    expect(got?.id).toBe(bonus);
  });

  it('readEmployeeReadiness: the latest run is the calculated bonus, not the approved regular run', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, [REGULAR, { ...BONUS, status: 'calculated' }]); },
      () => readEmployeeReadiness(A.company, A.employee));
    expect(got?.runs).toEqual([{ periodYear: 2026, periodMonth: 5, status: 'calculated' }]);
  });

  it('getDeclarablePayRun(May): the later declarable run of the month', async () => {
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => { [, bonus] = await seedBoth(c, [REGULAR, BONUS]); },
      () => getDeclarablePayRun(A.company, { year: 2026, month: 5 }));
    expect(got?.id).toBe(bonus);
    expect(got?.totalGross).toBe(5000);
  });
});

describe('the medical-credit record reads the latest line in run order', () => {
  it('the bonus (later) line recorded no credit: not recorded, whatever the regular line holds', async () => {
    const got = await twoRunsInMonth(pool, A,
      async (c) => { await seedBoth(c, [{ ...BONUS, medicalCredit: null }, { ...REGULAR, medicalCredit: 0 }]); },
      () => loadMedicalRecord(A.company, { start: '2026-03-01', end: '2027-02-28' }, [A.employee]));
    expect(got.get(A.employee)?.recorded).toBe(false);
  });
});

describe('readers of "the regular run of the month"', () => {
  it('the parallel-run report compares the import with the regular run, not the bonus', async () => {
    let regular = '';
    let importId = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      [, regular] = await seedBoth(c, [BONUS, REGULAR]);
      importId = String((await c.query(
        "INSERT INTO payroll_external_imports (company_id, period_month, period_year, file_name) VALUES ($1, 5, 2026, 'may.csv') RETURNING id",
        [A.company])).rows[0].id);
    }, () => getParallelRunReport(A.company, importId));
    expect(got?.run?.id).toBe(regular);
  });

  it('variance: the prior run of a regular June run is May\'s regular run, not the bonus', async () => {
    let regular = '';
    let june = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      [, regular, june] = await seedBoth(c, [BONUS, REGULAR, { ...REGULAR, month: 6, runDate: '2026-06-25' }]);
    }, () => getPayrollRunVariance(june, A.company));
    expect(got.priorRunId).toBe(regular);
    expect(got.totals.grossPay).toMatchObject({ current: 20000, prior: 20000 });
  });
});
