/**
 * Wave 5 DR, #1266 round 5 (Hein's ruling on adv2 L2, the narrow undo of a leaver exit): while the run that took a leaver
 * exit is reopened, a payroll approver may restore the directive's expiry to EXACTLY its value before the exit, and to
 * nothing else. Recalculating then puts the employee back in the run. The restore is audited (old and new expiry) and is
 * four-eyes: the person who took the exit may not restore it while another approver exists.
 * Refused: another date (400), no exit taken (400), the run not reopened (409), the exit's own taker (403); a refusal
 * writes nothing.
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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const made: SeveranceFixture[] = [];
afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_log WHERE company_id = ANY($1) AND entity_type = 'tax_directive'", [made.map(f => f.company)]);
    await cleanSeveranceFixtures(pool, made);
  } finally { await pool.end(); }
});

const patchEmployee = (f: SeveranceFixture, body: Record<string, unknown>) =>
  f.call(employeeRoute as Route, 'PATCH', `/api/payroll/employees/${f.employee}`, f.employee, { body, user: f.approver });
const recalc = (f: SeveranceFixture, run: string) => f.call(calculateRoute as Route, 'POST', `/api/payroll/runs/${run}/calculate`, run);

/** D approved, March taxed under it and approved, reopened; the employee left 02-28 and f.admin took the exit (03-01). */
async function exitTaken(
  name: string, window: { effective_date?: string; expiry_date?: string } = {}, beforeExit?: (f: SeveranceFixture) => Promise<unknown>,
) {
  const f = await drFixture(pool, name);
  made.push(f);
  const d = String((await postDirective(f, { ...PCT, ...window })).body.data!.id);
  expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
  const march = await createRunFor(f, 3);
  await calculateRun(f, march);
  expect((await approveRun(f, march)).statusCode).toBe(200);
  expect((await reopenRun(f, march)).statusCode).toBe(200);
  expect((await patchEmployee(f, { endDate: '2026-02-28' })).statusCode).toBe(200);
  await beforeExit?.(f);
  expect((await patchDirective(f, d, { expiry_date: '2026-03-01' })).statusCode).toBe(200);
  expect((await recalc(f, march)).statusCode).toBe(200);
  expect(await runLine(pool, march, f.employee)).toBeUndefined();
  return { f, d, march };
}

const expiryOf = async (d: string) => (await pool.query('SELECT expiry_date::text AS e FROM tax_directives WHERE id = $1', [d])).rows[0]!.e as string | null;
const undoRows = async (d: string) => (await pool.query(
  "SELECT user_id, changes FROM audit_log WHERE entity_type = 'tax_directive' AND entity_id = $1 AND changes->'metadata'->>'leaverExitUndo' = 'true'", [d])).rows;

/** A refused restore: the status, and nothing written (expiry still the exit's, no undo row). */
async function refused(f: SeveranceFixture, d: string, expiry: string, status: number, user?: string) {
  const r = await patchDirective(f, d, { expiry_date: expiry }, user);
  expect(r.statusCode, JSON.stringify(r.body)).toBe(status);
  expect(await expiryOf(d)).toBe('2026-03-01');
  expect(await undoRows(d)).toHaveLength(0);
  return r;
}

describe('the narrow undo of a leaver exit', () => {
  it('round trip: restored by another approver to exactly 2027-02-28 (no expiry), audited; the end date moves and March has the employee back under D', async () => {
    const { f, d, march } = await exitTaken('DR r5 round trip');
    // The end date is still held by the exit, and the 409 names the undo path.
    const held = await patchEmployee(f, { endDate: '2026-06-30' });
    expect(held.statusCode).toBe(409);
    expect(held.body.error?.message).toMatch(/restore the directive's expiry to what it was before the exit, then change the end date and recalculate/);
    const r = await patchDirective(f, d, { expiry_date: '2027-02-28' }, f.approver);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await expiryOf(d)).toBeNull();
    const rows = await undoRows(d);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(f.approver);
    expect(rows[0].changes.fields).toEqual([expect.objectContaining({ field: 'expiry_date', old: '2026-03-01', new: null })]);
    const exitId = (await pool.query(
      "SELECT id::text FROM audit_log WHERE entity_id = $1 AND changes->'metadata'->>'leaverExit' = 'true'", [d])).rows[0]!.id;
    expect(rows[0].changes.metadata).toEqual(expect.objectContaining({
      exitAuditId: exitId, employeeId: f.employee, runs: '2026-03', restoredEndsOn: '2027-02-28',
    }));
    expect(rows[0].changes.metadata.selfApproval).toBeUndefined();
    expect((await patchEmployee(f, { endDate: '2026-06-30' })).statusCode).toBe(200);
    expect((await recalc(f, march)).statusCode).toBe(200);
    expect((await runLine(pool, march, f.employee))?.paye).toBe(4000);
  });

  it('a stated expiry is restored as that date (2026-12-31)', async () => {
    const { f, d } = await exitTaken('DR r5 stated expiry', { expiry_date: '2026-12-31' });
    expect((await patchDirective(f, d, { expiry_date: '2026-12-31' }, f.approver)).statusCode).toBe(200);
    expect(await expiryOf(d)).toBe('2026-12-31');
  });

  it('another date: 400, nothing written', async () => {
    const { f, d } = await exitTaken('DR r5 other date');
    const r = await refused(f, d, '2026-12-31', 400, f.approver);
    expect(r.body.error?.message).toMatch(/exactly 2027-02-28/);
  });

  it('no exit taken (a plain lengthening): 400, nothing written', async () => {
    const f = await drFixture(pool, 'DR r5 no exit');
    made.push(f);
    const d = String((await postDirective(f, { ...PCT, expiry_date: '2026-03-01' })).body.data!.id);
    expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
    const r = await refused(f, d, '2027-02-28', 400, f.approver);
    expect(r.body.error?.message).toMatch(/none is in effect/);
  });

  it('the run not reopened (approved again): 409 LEAVER_EXIT_RUN_NOT_REOPENED, nothing written', async () => {
    const { f, d, march } = await exitTaken('DR r5 not reopened');
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [march]);
    const r = await refused(f, d, '2027-02-28', 409, f.approver);
    expect(r.body.error?.details?.code).toBe('LEAVER_EXIT_RUN_NOT_REOPENED');
    expect(r.body.error?.message).toMatch(/Reopen the 2026-03 payroll run first/);
  });

  it('four eyes: the person who took the exit may not restore it while another approver exists: 403, nothing written', async () => {
    const { f, d } = await exitTaken('DR r5 four eyes');
    await refused(f, d, '2027-02-28', 403, f.admin);
  });

  it('the exit in effect follows the expiry, and an undone exit is spent (forged states no route reaches): 400 each', async () => {
    // The expiry is no longer the exit's.
    const one = await exitTaken('DR r5 stale exit');
    await pool.query("UPDATE tax_directives SET expiry_date = '2026-03-05' WHERE id = $1", [one.d]);
    expect((await patchDirective(one.f, one.d, { expiry_date: '2027-02-28' }, one.f.approver)).statusCode).toBe(400);
    // The exit was undone; the expiry forged back to the exit's date does not make it undoable twice.
    const two = await exitTaken('DR r5 spent exit');
    expect((await patchDirective(two.f, two.d, { expiry_date: '2027-02-28' }, two.f.approver)).statusCode).toBe(200);
    await pool.query("UPDATE tax_directives SET expiry_date = '2026-03-01' WHERE id = $1", [two.d]);
    expect((await patchDirective(two.f, two.d, { expiry_date: '2027-02-28' }, two.f.approver)).statusCode).toBe(400);
    expect(await undoRows(two.d)).toHaveLength(1);
  });

  it('security: another run that taxed the employee inside the restored window (April, approved after the exit): 409 LEAVER_EXIT_WINDOW_TAKEN, nothing written', async () => {
    const { f, d } = await exitTaken('DR r5 window taken');
    const april = await createRunFor(f, 4);
    await calculateRun(f, april);
    // April approved, having taxed the employee without D (forged: e.g. a severance-only leaver line; the fixture's April has
    // nobody else, so it cannot be approved through the route, and no route puts a leaver in it otherwise).
    await pool.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = now(), approved_taxed_employees = ARRAY[$2::uuid] WHERE id = $1",
      [april, f.employee]);
    const r = await refused(f, d, '2027-02-28', 409, f.approver);
    expect(r.body.error?.details?.code).toBe('LEAVER_EXIT_WINDOW_TAKEN');
    expect(r.body.error?.message).toMatch(/The 2026-04 payroll run taxed this employee inside the window/);
  });

  it('adv2 L: four eyes judge the roster at the exit: the other approver demoted after it still blocks the taker (403, nothing written)', async () => {
    const { f, d } = await exitTaken('DR r5 roster at exit');
    const exit = (await pool.query(
      "SELECT changes FROM audit_log WHERE entity_id = $1 AND changes->'metadata'->>'leaverExit' = 'true'", [d])).rows[0]!;
    expect(exit.changes.metadata.approversAtExit).toBe(f.approver);
    await pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [f.company, f.approver]);
    await refused(f, d, '2027-02-28', 403, f.admin);
  });

  it('the sole approver at the exit may undo it themselves; the audit says sole_approver', async () => {
    const demote = (f: SeveranceFixture) => pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [f.company, f.approver]);
    const { f, d } = await exitTaken('DR r5 sole approver', {}, demote);
    expect((await patchDirective(f, d, { expiry_date: '2027-02-28' }, f.admin)).statusCode).toBe(200);
    expect((await undoRows(d))[0].changes.metadata.selfApproval).toBe('sole_approver');
  });

  it('rev2 L1: a hand-inserted exit row (a viewer as actor) on a directive with no recorded use is ignored: 400 no exit in effect', async () => {
    const f = await drFixture(pool, 'DR r5 forged exit');
    made.push(f);
    const d = String((await postDirective(f, { ...PCT, expiry_date: '2026-03-01' })).body.data!.id);
    expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
    await pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [f.company, f.approver]);
    const changes = {
      fields: [{ field: 'expiry_date', old: null, new: '2026-03-01', label: 'Expiry date' }],
      metadata: { leaverExit: 'true', employeeId: f.employee, runs: '2026-03', oldEndsOn: '2027-02-28', newExpiry: '2026-03-01', approversAtExit: '' },
    };
    await pool.query(`INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, changes)
      VALUES ($1, $2, 'update', 'tax_directive', $3, $4)`, [f.company, f.approver, d, JSON.stringify(changes)]);
    const r = await refused(f, d, '2027-02-28', 400, f.admin);
    expect(r.body.error?.message).toMatch(/none is in effect/);
  });

  it('rev2 L: an exit whose taker was demoted since is undone by another current approver', async () => {
    const { f, d } = await exitTaken('DR r5 departed taker');
    await pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [f.company, f.admin]);
    expect((await patchDirective(f, d, { expiry_date: '2027-02-28' }, f.approver)).statusCode).toBe(200);
    expect(await expiryOf(d)).toBeNull();
    expect(await undoRows(d)).toHaveLength(1);
  });

  it('rev2 L1: an exit-shaped row naming runs the directive has no recorded use in is ignored: 400', async () => {
    const { f, d } = await exitTaken('DR r5 forged runs');
    // The exit's own row altered (forged) to name May.
    await pool.query(`UPDATE audit_log SET changes = jsonb_set(changes, '{metadata,runs}', '"2026-05"')
      WHERE entity_id = $1 AND changes->'metadata'->>'leaverExit' = 'true'`, [d]);
    await refused(f, d, '2027-02-28', 400, f.approver);
  });

  it('adv2 L2: an exit row (forged) recording a later end than the tax year the directive starts in: 400, nothing restored', async () => {
    const { f, d } = await exitTaken('DR r5 forged later end');
    await pool.query(`UPDATE audit_log SET changes = jsonb_set(changes, '{metadata,oldEndsOn}', '"2027-06-30"')
      WHERE entity_id = $1 AND changes->'metadata'->>'leaverExit' = 'true'`, [d]);
    const r = await refused(f, d, '2027-06-30', 400, f.approver);
    expect(r.body.error?.message).toMatch(/no later than 2027-02-28, the end of the tax year the directive starts in/);
  });

  it('adv2 L2: two live exit rows for the current expiry (one hand-inserted): 409 LEAVER_EXIT_AMBIGUOUS, nothing restored', async () => {
    const { f, d } = await exitTaken('DR r5 two exits');
    await pool.query(`INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, entity_ref, changes, created_at)
      SELECT company_id, user_id, action, entity_type, entity_id, entity_ref, changes, now() + interval '1 second' FROM audit_log
      WHERE entity_id = $1 AND changes->'metadata'->>'leaverExit' = 'true'`, [d]);
    const r = await refused(f, d, '2027-02-28', 409, f.approver);
    expect(r.body.error?.details?.code).toBe('LEAVER_EXIT_AMBIGUOUS');
  });
});
