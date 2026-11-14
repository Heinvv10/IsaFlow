/**
 * Wave 5 DR, #1266 round 3 (real routes and SQL; migration 979). Each describe owns its company.
 *
 * - M1: a directive's use is recorded at run approval (payroll_run_directive_uses) and survives a reopen. A reopened
 *   run whose employee became a contractor (the tax-status route) or left its population (the end-date route) cannot be
 *   recalculated off the directive (409, nothing written), and the directive guards read the record, not the lines.
 *   Restoring the change lets the recalculation through, still under the directive.
 * - M1 (retroactive): an employee dropped from a reopened run still counts as paid in it (approved_taxed_employees).
 * - L-a: four eyes judge the roster as of capture: demoting or removing the other approver before approving does not open
 *   self-approval, and the snapshot sees the whole roster even when the creator is a manager (the R-035 definer).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import employeeRoute from '../../pages/api/payroll/employees/[id]';
import calculateRoute from '../../pages/api/payroll/runs/[id]/calculate';
import type { Route } from './w3-01-payroll.helpers';
import {
  approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, reopenRun, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { drFixture, patchDirective, PCT, postDirective } from './w5-dr.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const made: SeveranceFixture[] = [];
const fixture = async (name: string) => { const f = await drFixture(pool, name); made.push(f); return f; };
afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_log WHERE company_id = ANY($1) AND entity_type = 'tax_directive'", [made.map(f => f.company)]);
    await cleanSeveranceFixtures(pool, made);
  } finally { await pool.end(); }
});

const patchEmployee = (f: SeveranceFixture, body: Record<string, unknown>) =>
  f.call(employeeRoute as Route, 'PATCH', `/api/payroll/employees/${f.employee}`, f.employee, { body, user: f.approver });
const recalc = (f: SeveranceFixture, run: string) => f.call(calculateRoute as Route, 'POST', `/api/payroll/runs/${run}/calculate`, run);
const lineCount = async (run: string) => Number((await pool.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!.n);

/** March approved under a 20% directive D, then reopened. */
async function approvedUnderDThenReopened(name: string) {
  const f = await fixture(name);
  const d = String((await postDirective(f, PCT)).body.data!.id);
  expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
  const march = await createRunFor(f, 3);
  await calculateRun(f, march);
  expect((await approveRun(f, march)).statusCode).toBe(200);
  expect((await reopenRun(f, march)).statusCode).toBe(200);
  return { f, d, march };
}

describe('M1: the use is recorded at approval and survives the reopen', () => {
  it('tax status to contractor: recalculation 409 (lines unchanged); the guards read the record even when the line loses the flag', async () => {
    const { f, d, march } = await approvedUnderDThenReopened('DR r3 contractor');
    expect((await pool.query('SELECT count(*)::int AS n FROM payroll_run_directive_uses WHERE run_id = $1 AND directive_id = $2', [march, d])).rows[0]!.n).toBe(1);
    expect((await patchEmployee(f, { taxStatus: 'independent_contractor' })).statusCode).toBe(200);
    const before = await runLine(pool, march, f.employee);
    const r = await recalc(f, march);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error?.message).toMatch(/approved with SARS directive 1234567 .*tax status/);
    expect((await runLine(pool, march, f.employee)).paye).toBe(before.paye);
    // As if a recalculation had slipped through: the line no longer names D. The guards still refuse.
    await pool.query("UPDATE payroll_run_lines SET validation_results = '[]'::jsonb WHERE run_id = $1", [march]);
    expect((await patchDirective(f, d, { status: 'cancelled' })).statusCode).toBe(409);
    expect((await patchDirective(f, d, { expiry_date: '2026-03-30' })).statusCode).toBe(400);
    // Restored, the run recalculates, still under D.
    expect((await patchEmployee(f, { taxStatus: 'employee' })).statusCode).toBe(200);
    expect((await recalc(f, march)).statusCode).toBe(200);
    expect((await runLine(pool, march, f.employee)).paye).toBe(4000);
  });

  it('dropped from the population (end date before March): recalculation 409 naming the exit; D ended at the leave date, it recalculates', async () => {
    const { f, d, march } = await approvedUnderDThenReopened('DR r3 population');
    expect((await patchEmployee(f, { endDate: '2026-02-28' })).statusCode).toBe(200);
    const lines = await lineCount(march);
    const r = await recalc(f, march);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error?.message).toMatch(/end the directive at the leave date/);
    expect(await lineCount(march)).toBe(lines);
    // The way out for a real leaver (round 4 L2): end D at the leave date, then the recalculation drops them.
    // D starts on 03-01, after the 02-28 leave date: the earliest it can end is its effective date. Before it: 400.
    expect((await patchDirective(f, d, { expiry_date: '2026-02-28' })).statusCode).toBe(400);
    expect((await patchDirective(f, d, { expiry_date: '2026-03-01' })).statusCode).toBe(200);
    expect((await recalc(f, march)).statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [march, f.employee])).rows[0]!.n).toBe(0);
    // The record stays: D still cannot be cancelled.
    expect((await patchDirective(f, d, { status: 'cancelled' })).statusCode).toBe(409);
  });

  it('retroactive: an employee dropped from a reopened run still counts as paid in it', async () => {
    const f = await fixture('DR r3 retro dropped');
    const march = await createRunFor(f, 3);
    await calculateRun(f, march);
    expect((await approveRun(f, march)).statusCode).toBe(200);
    expect((await reopenRun(f, march)).statusCode).toBe(200);
    expect((await patchEmployee(f, { endDate: '2026-02-28' })).statusCode).toBe(200);
    await calculateRun(f, march);
    expect((await pool.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [march, f.employee])).rows[0]!.n).toBe(0);
    await pool.query('UPDATE payroll_employees SET end_date = NULL WHERE id = $1', [f.employee]);
    const r = await postDirective(f, PCT);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/2026-03 payroll run .*has been approved/);
  });
});

describe('L-a: four eyes judge the roster as of capture', () => {
  it('the owner demoted to viewer after capture: the creator still may not approve', async () => {
    const f = await fixture('DR r3 roster');
    const d = String((await postDirective(f, PCT)).body.data!.id);
    expect((await pool.query('SELECT approvers_at_create FROM tax_directives WHERE id = $1', [d])).rows[0]!.approvers_at_create).toEqual([f.approver]);
    await pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [f.company, f.approver]);
    const own = await patchDirective(f, d, { status: 'approved' }, f.admin);
    expect(own.statusCode, JSON.stringify(own.body)).toBe(403);
  });

  it('the other approver REMOVED from the company after capture: the creator still may not approve', async () => {
    const f = await fixture('DR r3 removed');
    const d = String((await postDirective(f, PCT)).body.data!.id);
    await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [f.company, f.approver]);
    const own = await patchDirective(f, d, { status: 'approved' }, f.admin);
    expect(own.statusCode, JSON.stringify(own.body)).toBe(403);
    expect(own.body.error?.message).toMatch(/cancel this directive and create it again/);
  });

  it('a MANAGER creator (company_users RLS shows them only their own row) still records the owner; demoted later, still refused', async () => {
    const f = await fixture('DR r3 manager');
    await pool.query("UPDATE company_users SET role = 'manager' WHERE company_id = $1 AND user_id = $2", [f.company, f.admin]);
    const made = await postDirective(f, PCT);
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const d = String(made.body.data!.id);
    expect((await pool.query('SELECT approvers_at_create FROM tax_directives WHERE id = $1', [d])).rows[0]!.approvers_at_create).toEqual([f.approver]);
    await pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [f.company, f.approver]);
    expect((await patchDirective(f, d, { status: 'approved' }, f.admin)).statusCode).toBe(403);
  });
});
