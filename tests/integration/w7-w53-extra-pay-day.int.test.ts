/**
 * W1 (wave 7 W53) on real Postgres, two tenants: a Sunday-paid weekly year (tax year 2027: 1 March 2026 and 28 February
 * 2027 are both Sundays, 53 pay days), every run calculated by the real writer (calculatePayrollRun) and approved before
 * the next, so n comes from the stored lines through the year-to-date reader (payrollYearToDate), not from a fixture.
 *
 *  - SARS is silent on a 53rd pay day (PAYE-GEN-01-G21 (2027) Rev 1 p. 9; ruling 9): PAYE stays x 52, so week 53 of
 *    R3 000 a week is 10 260 x 53 / 52 less the 52 weeks' 10 260.00 = 197.31, and only that line carries WEEK_53_PAY_DAY;
 *  - week 52 (n = 52 = P) carries none;
 *  - tenant B (R30 000 a week, 10x) runs only weeks 52 and 53 (a later-dated window): its week 53 is its second period, so no warning: A's
 *    52 lines never count toward B's n;
 *  - the year-to-date reader returns n = 52 and the lines' one frequency, weekly (review #1928 (3));
 *  - the run is stamped with calculation version 22.
 * Each case runs in its own transaction and rolls everything back (w6-fqb1.helpers twoRunsInMonth).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedTenant, twoRunsInMonth, type Tenant } from './w6-fqb1.helpers';
import { approve, line, seedWeekly } from './w6-fqc.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { PAYROLL_CALCULATION_VERSION } from '@/modules/accounting/services/payroll/payrollCalculationVersion';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;
let c: PoolClient;

beforeAll(async () => {
  A = await seedTenant(pool, 'W7 W53 A');
  B = await seedTenant(pool, 'W7 W53 B');
});

afterAll(async () => {
  try { await dropTenants(pool, [A, B]); } finally { await pool.end(); }
});

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Week k (0-based) of tax year 2027, Monday to Sunday, paid on the Sunday: week 0 ends 1 March 2026, week 52 ends 28 February 2027. */
const weekOf = (k: number): [string, string] => {
  const start = Date.UTC(2026, 1, 23) + 7 * k * DAY;
  return [iso(start), iso(start + 6 * DAY)];
};

async function weekRun(t: Tenant, [start, end]: [string, string]): Promise<string> {
  return String((await c.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, pay_frequency, period_start, period_end)
     VALUES ($1, $2, $3, 'draft', 'weekly', $4::date, $5::date) RETURNING id`,
    [t.company, Number(end.slice(5, 7)), Number(end.slice(0, 4)), start, end])).rows[0].id);
}

async function costAndApprove(t: Tenant, week: [string, string]): Promise<string> {
  const id = await weekRun(t, week);
  await calculatePayrollRun(id, t.company);
  await approve(c, id);
  return id;
}

describe('a 53rd weekly pay day: x 52 kept, the line warned (G21 (2027) Rev 1 p. 9 silent; ruling 9)', () => {
  it('only week 53 warns; B (10x, a later-dated window of two periods) does not; version 22', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      const b = await seedWeekly(c, B);
      await c.query('UPDATE payroll_employee_components SET amount = 3000 WHERE employee_id = $1', [a.big]);
      await c.query('UPDATE payroll_employee_components SET amount = 30000 WHERE employee_id = $1', [b.big]);
      const runs: string[] = [];
      let bWeeks: string[] = [];
      let ytd53: { periods: number; frequencies?: string[] } | undefined;
      for (let k = 0; k <= 52; k += 1) {
        if (k >= 51) bWeeks = [...bWeeks, await costAndApprove(B, weekOf(k))];
        if (k === 52) {
          const id = await weekRun(A, weekOf(k));
          ytd53 = (await loadPayeYearToDate(A.company, id, { year: 2027, month: 2 }, [a.big])).get(a.big);
          await calculatePayrollRun(id, A.company);
          await approve(c, id);
          runs.push(id);
        } else {
          runs.push(await costAndApprove(A, weekOf(k)));
        }
      }
      const aLines = await Promise.all(runs.map((r) => line(c, r, a.big)));
      const version = (await c.query('SELECT calculation_version FROM payroll_run_headers WHERE id = $1', [runs[52]])).rows[0].calculation_version;
      return {
        aLines, version, ytd53,
        bWeek53: await line(c, bWeeks[1]!, b.big),
        bWeek52: await line(c, bWeeks[0]!, b.big),
      };
    });
    const warned = got.aLines.map((l, i) => (l.codes.includes('WEEK_53_PAY_DAY') ? i + 1 : null)).filter((x) => x !== null);
    expect(warned).toEqual([53]);
    expect(got.aLines[51]!.codes).not.toContain('WEEK_53_PAY_DAY');
    // 10 260 a year (18% x 156 000 - 17 820); 52 weeks paid 10 260.00 by true-up, so week 53 = 10 260 x 53 / 52 - 10 260.
    expect(got.aLines.slice(0, 52).reduce((s, l) => s + l.paye, 0)).toBeCloseTo(10260, 2);
    expect(got.aLines[52]!.paye).toBe(197.31);
    // The reader's n and the frequencies of the year's tables lines (review #1928 (3): one frequency, so the warning stands).
    expect(got.ytd53).toMatchObject({ periods: 52, frequencies: ['weekly'] });
    expect(got.bWeek53.gross).toBe(30000);
    expect(got.bWeek53.codes).not.toContain('WEEK_53_PAY_DAY');
    expect(got.bWeek52.codes).not.toContain('WEEK_53_PAY_DAY');
    expect(Number(got.version)).toBe(PAYROLL_CALCULATION_VERSION);
  }, 300_000);
});
