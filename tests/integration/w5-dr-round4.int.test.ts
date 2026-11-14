/**
 * Wave 5 DR, #1266 round 4 L: POST /api/accounting/tax-directives/[id]/apply on a fixed-percentage / fixed-amount
 * directive answers 400 "each run applies it" BEFORE ET's wrapper (directivePaymentEti) takes the company lock and judges
 * later ETI journals, so in an ETI period with a later month's journal in force the caller does not get the ETI 409.
 *
 * Security review of the leaver exit (round 4): a directive may end before a run it taxed only at the leave date of an
 * employee who left BEFORE that run's period, and that end date cannot then move (409). The attack (an early end date to
 * unlock the shortening, then the end date moved back and the run recalculated on the tables) is refused at both steps;
 * a real leaver still gets out.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import employeeRoute from '../../pages/api/payroll/employees/[id]';
import calculateRoute from '../../pages/api/payroll/runs/[id]/calculate';
import type { Route } from './w3-01-payroll.helpers';
import {
  applyStandalone, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, reopenRun, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { drFixture, patchDirective, PCT, postDirective } from './w5-dr.helpers';
import { assertRunKeepsItsDirectives } from '@/modules/accounting/services/payroll/payrollRunDirectiveUses';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const made: SeveranceFixture[] = [];
afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_log WHERE company_id = ANY($1) AND entity_type = 'tax_directive'", [made.map(f => f.company)]);
    await cleanSeveranceFixtures(pool, made);
  } finally { await pool.end(); }
});

describe('apply on a regular-pay directive in an ETI period with a later journal in force', () => {
  it('400 TaxDirectiveNotLumpSum, not the ETI 409; no payment row', async () => {
    const f = await drFixture(pool, 'DR r4 apply ETI');
    made.push(f);
    const d = String((await postDirective(f, { ...PCT, effective_date: '2026-06-01' })).body.data!.id);
    expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
    for (const month of [3, 4]) {
      const run = await createRunFor(f, month);
      await calculateRun(f, run);
      expect((await approveRun(f, run)).statusCode).toBe(200);
    }
    // March carries ETI, so the March-August period has ETI and April's run journal is a later month in force.
    await pool.query('UPDATE payroll_run_headers SET total_eti = 100 WHERE company_id = $1 AND period_month = 3', [f.company]);
    const r = await applyStandalone(f, d, '2026-03-15');
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/cannot be paid as a lump sum/);
    expect((await pool.query('SELECT count(*)::int AS n FROM tax_directive_payments WHERE tax_directive_id = $1', [d])).rows[0]!.n).toBe(0);
  });
});

const patchEmployee = (f: SeveranceFixture, body: Record<string, unknown>) =>
  f.call(employeeRoute as Route, 'PATCH', `/api/payroll/employees/${f.employee}`, f.employee, { body, user: f.approver });
const recalc = (f: SeveranceFixture, run: string) => f.call(calculateRoute as Route, 'POST', `/api/payroll/runs/${run}/calculate`, run);

async function marchUnderDReopened(name: string, window: { effective_date?: string; expiry_date?: string } = {}) {
  const f = await drFixture(pool, name);
  made.push(f);
  const d = String((await postDirective(f, { ...PCT, ...window })).body.data!.id);
  expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
  const march = await createRunFor(f, 3);
  await calculateRun(f, march);
  expect((await approveRun(f, march)).statusCode).toBe(200);
  expect((await reopenRun(f, march)).statusCode).toBe(200);
  return { f, d, march };
}

describe('the leaver exit cannot be borrowed', () => {
  it('an end date inside the taxed period does not unlock shortening the directive below that run: 400', async () => {
    const { f, d } = await marchUnderDReopened('DR r4 mid-period end');
    expect((await patchEmployee(f, { endDate: '2026-03-10' })).statusCode).toBe(200);
    expect((await patchDirective(f, d, { expiry_date: '2026-03-10' })).statusCode).toBe(400);
  });

  it('an early end date unlocks it, but moving the end date back is then 409, and March stays under D', async () => {
    const { f, d, march } = await marchUnderDReopened('DR r4 attack');
    expect((await patchEmployee(f, { endDate: '2026-02-15' })).statusCode).toBe(200);
    expect((await patchDirective(f, d, { expiry_date: '2026-03-01' })).statusCode).toBe(200);
    const back = await patchEmployee(f, { endDate: '2026-06-30' });
    expect(back.statusCode, JSON.stringify(back.body)).toBe(409);
    expect(String((await pool.query('SELECT end_date::text AS e FROM payroll_employees WHERE id = $1', [f.employee])).rows[0]!.e)).toBe('2026-02-15');
    // Still a leaver before March, so the recalculation takes them out: no line left for the tables.
    expect((await recalc(f, march)).statusCode).toBe(200);
    expect(await runLine(pool, march, f.employee)).toBeUndefined();
  });

  it('a real leaver (left before March) ends D at its effective date and recalculates', async () => {
    const { f, d, march } = await marchUnderDReopened('DR r4 real leaver');
    expect((await patchEmployee(f, { endDate: '2026-02-28' })).statusCode).toBe(200);
    expect((await patchDirective(f, d, { expiry_date: '2026-03-01' })).statusCode).toBe(200);
    expect((await recalc(f, march)).statusCode).toBe(200);
    // An earlier leave date still explains it: allowed.
    expect((await patchEmployee(f, { endDate: '2026-02-20' })).statusCode).toBe(200);
  });

  it('the recalculation guard itself: a directive ended at an end date INSIDE the taxed period does not excuse a missing leaver', async () => {
    const { f, march } = await marchUnderDReopened('DR r4 guard predicate');
    // A state no route reaches (forged): left 03-10, D ended 03-10, and the employee not in the population handed in.
    await pool.query("UPDATE payroll_employees SET end_date = '2026-03-10' WHERE id = $1", [f.employee]);
    await pool.query("UPDATE tax_directives SET expiry_date = '2026-03-10' WHERE company_id = $1", [f.company]);
    await expect(assertRunKeepsItsDirectives(f.company, march, [], new Map())).rejects.toThrow(/approved with SARS directive/);
    await pool.query("UPDATE payroll_employees SET end_date = '2026-02-28' WHERE id = $1", [f.employee]);
    await pool.query("UPDATE tax_directives SET expiry_date = '2026-03-01' WHERE company_id = $1", [f.company]);
    await expect(assertRunKeepsItsDirectives(f.company, march, [], new Map())).resolves.toBeUndefined();
  });

  it('rev2 L3: after the exit, an end date that no longer precedes the directive\'s end is 409 (to 03-01; and, for D ending 02-20, to 02-25)', async () => {
    const one = await marchUnderDReopened('DR r4 L3 a');
    expect((await patchEmployee(one.f, { endDate: '2026-02-15' })).statusCode).toBe(200);
    expect((await patchDirective(one.f, one.d, { expiry_date: '2026-03-01' })).statusCode).toBe(200);
    expect((await patchEmployee(one.f, { endDate: '2026-03-01' })).statusCode).toBe(409);
    // D from 02-01 to 12-31 (a window across the tax-year end, stated on it): ended 02-20 for a 02-15 leaver. 02-25 is still
    // before March but after D's end: 409 (ends_on >= newEnd).
    const two = await marchUnderDReopened('DR r4 L3 b', { effective_date: '2026-02-01', expiry_date: '2026-12-31' });
    expect((await patchEmployee(two.f, { endDate: '2026-02-15' })).statusCode).toBe(200);
    expect((await patchDirective(two.f, two.d, { expiry_date: '2026-02-20' })).statusCode).toBe(200);
    expect((await patchEmployee(two.f, { endDate: '2026-02-25' })).statusCode).toBe(409);
    expect((await patchEmployee(two.f, { endDate: '2026-02-18' })).statusCode).toBe(200);
  });

  it('adv2 L1: the leaver exit writes an audit row naming the directive, the employee, the runs and the expiries', async () => {
    const { f, d } = await marchUnderDReopened('DR r4 L1 audit');
    expect((await patchEmployee(f, { endDate: '2026-02-28' })).statusCode).toBe(200);
    expect((await patchDirective(f, d, { expiry_date: '2026-03-01' })).statusCode).toBe(200);
    const rows = (await pool.query(
      "SELECT action, entity_ref, changes FROM audit_log WHERE entity_type = 'tax_directive' AND entity_id = $1 AND action = 'update'", [d])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_ref).toBe('1234567');
    expect(rows[0].changes.metadata).toEqual(expect.objectContaining({
      leaverExit: 'true', employeeId: f.employee, employeeEndDate: '2026-02-28', runs: '2026-03', oldEndsOn: '2027-02-28', newExpiry: '2026-03-01',
    }));
    expect(rows[0].changes.fields).toEqual([expect.objectContaining({ field: 'expiry_date', old: null, new: '2026-03-01' })]);
  });
});
