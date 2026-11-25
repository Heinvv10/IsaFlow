/**
 * FQe (wave 7, Hein ruling 23, engine 23) on real Postgres, two tenants. Each tenant's earlier runs are calculated by the
 * real writer (calculatePayrollRun) and approved, then the employee's pay frequency changes and the year-to-date reader
 * (loadPayeYearToDate) is read for the first run at the new frequency:
 *  - A: four weeks at R8 000 (2-29 March 2026), then a fortnight (30 March - 12 April) at R16 000. The reader returns the
 *    periods by frequency ({ weekly: 4 }), the calculator's conversion counts them as 2 fortnights (share x 26 / 52), and
 *    the cumulative PAYE on them is 72 377 x 3 / 26 less the four stored weekly PAYE figures (2 783.73 here; the oracle
 *    case frequency-change-weekly-to-fortnightly gives 2 783.71 on priors of 1 391.87 each). Counted raw (n = 5) it was nil.
 *  - B (10x: R160 000 a fortnight, then R80 000 a week, a later-dated window in June-July): two fortnights then a week,
 *    { fortnightly: 2 } = 4 weeks; A's lines never reach B's reader, nor B's A's.
 *  - The writer still refuses the run at the new frequency (refuseMixedFrequencyYear, 409 frequency_change): FQe fixes the
 *    divisor; lifting the mid-year guard is a separate decision (PR body).
 * SARS is silent on a change of pay period (PAYE-GEN-01-G21 (2027) Rev 1 p. 8-9): UNVERIFIED, warned on the line.
 * Each case runs in one transaction and rolls everything back (w6-fqb1.helpers twoRunsInMonth).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedTenant, twoRunsInMonth, type Tenant } from './w6-fqb1.helpers';
import { approve, line, seedWeekly } from './w6-fqc.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { PAY_FREQUENCY_CHANGED, ytdInFrequency } from '@/modules/accounting/services/payroll/payrollYearToDateFrequency';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import type { PayeYearToDate, PayFrequency } from '@/modules/accounting/services/payroll/payrollTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;
let c: PoolClient;

beforeAll(async () => {
  A = await seedTenant(pool, 'W7 FQe A');
  B = await seedTenant(pool, 'W7 FQe B');
});

afterAll(async () => {
  try { await dropTenants(pool, [A, B]); } finally { await pool.end(); }
});

const round2 = (n: number) => Math.round(n * 100) / 100;
/** The 2027 statutory annual tax less the primary rebate (PAYE-GEN-01-G21 (2027) p. 4), independent of the engine. */
const tax2027 = (x: number) => {
  const b = [[1, 245_100, 0, 0.18], [245_101, 383_100, 44_118, 0.26], [383_101, 530_200, 79_998, 0.31], [530_201, 695_800, 125_599, 0.36],
    [695_801, 887_000, 185_215, 0.39], [887_001, 1_878_600, 259_783, 0.41], [1_878_601, Infinity, 666_339, 0.45]].find(([, to]) => x <= to!)!;
  return Math.max(0, b[2]! + b[3]! * (x - b[0]! + 1) - 17_820);
};

async function run(t: Tenant, frequency: PayFrequency, start: string, end: string): Promise<string> {
  return String((await c.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, pay_frequency, period_start, period_end)
     VALUES ($1, $2, $3, 'draft', $4, $5::date, $6::date) RETURNING id`,
    [t.company, Number(end.slice(5, 7)), Number(end.slice(0, 4)), frequency, start, end])).rows[0].id);
}

async function setTerms(employee: string, frequency: PayFrequency, amount: number): Promise<void> {
  await c.query('UPDATE payroll_employees SET pay_frequency = $2 WHERE id = $1', [employee, frequency]);
  await c.query('UPDATE payroll_employee_components SET amount = $2 WHERE employee_id = $1', [employee, amount]);
}

/** Costs and approves each window at `frequency`, returning the employee's stored PAYE on each. */
async function paid(t: Tenant, employee: string, frequency: PayFrequency, windows: [string, string][]): Promise<number[]> {
  const out: number[] = [];
  for (const [start, end] of windows) {
    const id = await run(t, frequency, start, end);
    await calculatePayrollRun(id, t.company);
    await approve(c, id);
    out.push((await line(c, id, employee)).paye);
  }
  return out;
}

async function refusal(id: string, company: string): Promise<{ status?: number; clause?: string }> {
  try {
    await calculatePayrollRun(id, company);
    return {};
  } catch (err) {
    const e = err as { status?: number; reasons?: { clause: string }[] };
    return { status: e.status, clause: e.reasons?.[0]?.clause };
  }
}

/** The cumulative PAYE on the line at `frequency`, on the reader's year to date as the calculator converts it (or raw). */
const cumulative = (ytd: PayeYearToDate, frequency: PayFrequency, pay: number, convert = true) => {
  const { ytd: converted, warnings } = convert ? ytdInFrequency(ytd, frequency) : { ytd, warnings: [] };
  const P = frequency === 'weekly' ? 52 : 26;
  const r = calculateCumulativePaye({
    ytd: converted, periodicRemuneration: pay, regularTaxable: pay, annualPayments: 0, annualPaymentRemuneration: 0,
    taxYear: 2027, rebateAge: 46, monthlyMedicalBeneficiaries: 0, medicalSchemeFees: 0, factor: P, periodsInYear: P, periodShare: 1,
  });
  return { converted, warnings, paye: r.regular.monthlyPaye, n: r.periods };
};

describe('a mid-year pay-frequency change: the year to date counted in the new frequency (FQe, engine 23)', () => {
  it('A weekly -> fortnightly and B (10x, later window) fortnightly -> weekly, from stored lines', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = (await seedWeekly(c, A)).big;
      const b = (await seedWeekly(c, B)).big;
      await setTerms(a, 'weekly', 8_000);
      const aWeeks = await paid(A, a, 'weekly', [['2026-03-02', '2026-03-08'], ['2026-03-09', '2026-03-15'], ['2026-03-16', '2026-03-22'], ['2026-03-23', '2026-03-29']]);
      await setTerms(b, 'fortnightly', 160_000);
      const bFortnights = await paid(B, b, 'fortnightly', [['2026-06-01', '2026-06-14'], ['2026-06-15', '2026-06-28']]);
      await setTerms(a, 'fortnightly', 16_000);
      await setTerms(b, 'weekly', 80_000);
      const aRun = await run(A, 'fortnightly', '2026-03-30', '2026-04-12');
      const bRun = await run(B, 'weekly', '2026-06-29', '2026-07-05');
      return {
        aWeeks, bFortnights,
        aYtd: (await loadPayeYearToDate(A.company, aRun, { year: 2026, month: 4 }, [a])).get(a),
        bYtd: (await loadPayeYearToDate(B.company, bRun, { year: 2026, month: 7 }, [b])).get(b),
        // Tenancy: each company's reader sees only its own lines.
        crossAB: (await loadPayeYearToDate(A.company, bRun, { year: 2026, month: 7 }, [b])).get(b),
        crossBA: (await loadPayeYearToDate(B.company, aRun, { year: 2026, month: 4 }, [a])).get(a),
        aRefused: await refusal(aRun, A.company),
        bRefused: await refusal(bRun, B.company),
      };
    });
    // A: 72 377 a year on R416 000; four weeks then the fortnight.
    expect(round2(got.aWeeks.reduce((s, x) => s + x, 0))).toBe(round2(tax2027(416_000) * 4 / 52));
    expect(got.aYtd).toMatchObject({ periods: 4, frequencies: ['weekly'], periodsByFrequency: { weekly: 4 }, retirementCapPeriodsByFrequency: { weekly: 4 } });
    const a = cumulative(got.aYtd!, 'fortnightly', 16_000);
    expect(a.converted.periods).toBe(2);
    expect(a.n).toBe(3);
    expect(a.warnings.map((w) => w.code)).toEqual([PAY_FREQUENCY_CHANGED]);
    expect(a.paye).toBe(round2(round2(tax2027(416_000) * 3 / 26) - got.aYtd!.tablePaye));
    expect(a.paye).toBeGreaterThan(2_780);
    // The raw count (n = 5) PAYE ruling 23 measured: nil.
    expect(cumulative(got.aYtd!, 'fortnightly', 16_000, false)).toMatchObject({ n: 5, paye: 0 });
    // B: 10x, R4 160 000 a year; two fortnights then the week.
    expect(got.bYtd).toMatchObject({ periods: 2, frequencies: ['fortnightly'], periodsByFrequency: { fortnightly: 2 } });
    const b = cumulative(got.bYtd!, 'weekly', 80_000);
    expect(b.converted.periods).toBe(4);
    expect(b.paye).toBe(round2(round2(tax2027(4_160_000) * 5 / 52) - got.bYtd!.tablePaye));
    expect(got.bFortnights).toHaveLength(2);
    expect(got.crossAB).toBeUndefined();
    expect(got.crossBA).toBeUndefined();
    // The writer still refuses a run after a mid-year change (payrollFrequencyGuard.refuseMixedFrequencyYear).
    expect(got.aRefused).toEqual({ status: 409, clause: 'frequency_change' });
    expect(got.bRefused).toEqual({ status: 409, clause: 'frequency_change' });
  }, 300_000);
});
