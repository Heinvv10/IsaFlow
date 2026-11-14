/**
 * Wave 5 DR, #1266 round 2 (real routes and SQL). Each describe owns its company.
 *
 * - M1: a run approved once and REOPENED still holds the directive that taxed it: cancel 409, an expiry before it 400,
 *   delete 409; and a new directive over a reopened month is refused as over an approved one.
 * - L1: approving a regular directive takes the company's payroll-approval lock first (it waits on a holder).
 * - Four eyes (Hein): the creator may not approve while another owner / admin / manager could (403), lump sum and
 *   regular alike; a one-person company self-approves and its audit row says sole_approver.
 * - Contractor (Hein): no regular directive for an independent contractor: create 400, approve 400, and a directive
 *   that reaches a contractor's line is an error the gate refuses (regular_directive_contractor).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  approveRun, calculateRun, cleanSeveranceFixtures, codes, createRunFor, previewRun, reopenRun, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { deleteDirective, drFixture, insertDirective, patchDirective, PCT, postDirective, whileLockHeld } from './w5-dr.helpers';

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
const status = async (id: string) => String((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [id])).rows[0]?.status ?? 'gone');

describe('M1: a reopened run still holds its directive', () => {
  it('approve March under D, reopen: cancel 409, expiry before March 400, delete 409', async () => {
    const f = await fixture('DR reopened');
    const d = String((await postDirective(f, PCT)).body.data!.id);
    expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
    const march = await createRunFor(f, 3);
    await calculateRun(f, march);
    expect((await approveRun(f, march)).statusCode).toBe(200);
    const reopened = await reopenRun(f, march);
    expect(reopened.statusCode, JSON.stringify(reopened.body)).toBe(200);
    expect((await patchDirective(f, d, { status: 'cancelled' })).statusCode).toBe(409);
    expect((await patchDirective(f, d, { expiry_date: '2026-03-30' })).statusCode).toBe(400);
    expect((await deleteDirective(f, d)).statusCode).toBe(409);
    expect(await status(d)).toBe('approved');
  });

  it('a new directive over a reopened month: 400, as over an approved one', async () => {
    const f = await fixture('DR reopened retro');
    const march = await createRunFor(f, 3);
    await calculateRun(f, march);
    expect((await approveRun(f, march)).statusCode).toBe(200);
    expect((await reopenRun(f, march)).statusCode).toBe(200);
    const r = await postDirective(f, PCT);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/2026-03 payroll run .*has been approved/);
  });
});

describe('L1: approving a regular directive takes the payroll-approval lock first', () => {
  it('a holder of payroll_approval:<company> makes the approve wait; released, it lands', async () => {
    const f = await fixture('DR approval lock');
    const d = String((await postDirective(f, PCT)).body.data!.id);
    const { result, waited } = await whileLockHeld(pool, `payroll_approval:${f.company}`, () => patchDirective(f, d, { status: 'approved' }));
    expect(waited).toBe(true);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
  });
});

describe('four eyes on approving a directive', () => {
  const lump = { directive_type: 'severance', amount: 10000, tax_rate: 0.1, effective_date: '2026-05-01', directive_number: '1112223' };
  it.each([['regular', PCT], ['lump-sum', lump]])('%s: the creator 403 while the owner can approve; the owner 200, audit not self-approved', async (_n, body) => {
    const f = await fixture(`DR four eyes ${_n}`);
    const d = String((await postDirective(f, body)).body.data!.id);
    const own = await patchDirective(f, d, { status: 'approved' }, f.admin);
    expect(own.statusCode, JSON.stringify(own.body)).toBe(403);
    expect(await status(d)).toBe('pending');
    expect((await patchDirective(f, d, { status: 'approved' }, f.approver)).statusCode).toBe(200);
    const audit = (await pool.query("SELECT user_id, changes FROM audit_log WHERE entity_id = $1 AND action = 'approve'", [d])).rows;
    expect(audit.map(a => [a.user_id, a.changes.metadata.selfApproval ?? null])).toEqual([[f.approver, null]]);
  });

  it('a one-person company self-approves, and the audit row says sole_approver', async () => {
    const f = await fixture('DR four eyes alone');
    await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [f.company, f.approver]);
    const d = String((await postDirective(f, PCT)).body.data!.id);
    expect((await patchDirective(f, d, { status: 'approved' }, f.admin)).statusCode).toBe(200);
    const audit = (await pool.query("SELECT changes FROM audit_log WHERE entity_id = $1 AND action = 'approve'", [d])).rows;
    expect(audit.map(a => a.changes.metadata.selfApproval)).toEqual(['sole_approver']);
  });
});

describe('no regular directive for an independent contractor', () => {
  it('create 400; approve 400 once the status changed; a directive on a contractor\'s line errors and the gate refuses', async () => {
    const f = await fixture('DR contractor');
    const pending = String((await postDirective(f, PCT)).body.data!.id);
    await pool.query("UPDATE payroll_employees SET tax_status = 'independent_contractor' WHERE id = $1", [f.employee]);
    const created = await postDirective(f, { ...PCT, effective_date: '2027-03-01', directive_number: '3334445' });
    expect(created.statusCode).toBe(400);
    expect(created.body.error?.message).toMatch(/change the tax status first/);
    const approve = await patchDirective(f, pending, { status: 'approved' });
    expect(approve.statusCode).toBe(400);
    expect(approve.body.error?.message).toMatch(/change the tax status first/);
    await insertDirective(pool, f.company, f.employee, { number: '4445556' });
    const run = await createRunFor(f, 3);
    await calculateRun(f, run);
    const line = await runLine(pool, run, f.employee);
    expect(codes(line.validation_results)).toContain('DIRECTIVE_FOR_CONTRACTOR');
    expect(line.paye).toBe(0);
    expect((await previewRun(f, run)).body.data?.blocker?.code).toBe('regular_directive_contractor');
  });
});
