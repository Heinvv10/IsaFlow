/**
 * PAYE 4a follow-ups G4, breaker round 4 on PR B, ported: reopening an approved
 * month and approving it again unchanged is not refused by the stale
 * year-to-date gate (a later month calculated after its first approval saw it).
 * Round 2 R1: the gate reads the approval periods a reopen ended (migration
 * 925), so a chain of unchanged re-approvals is not refused either.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import {
  approveRun, reopenRun, cleanSeveranceFixtures, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { PERIODS, seedEmployee, setSalary } from './p4fu-cumulative.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function mk(f: SeveranceFixture, year: number, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  if (made.statusCode !== 201) throw new Error(`create: ${made.statusCode}`);
  return String(made.body.data!.id);
}
async function calcOnly(f: SeveranceFixture, id: string) {
  const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  if (calc.statusCode !== 200) throw new Error(`calc ${calc.statusCode}`);
}
describe('G4: re-approving a reopened month', () => {
  it('reopen an approved month, change nothing, re-approve it: not refused', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4fu reopen unchanged', 20_000);
    const ids: string[] = [];
    for (const p of PERIODS.slice(0, 11)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); expect((await approveRun(f, id)).statusCode).toBe(200); ids.push(id); }
    expect((await reopenRun(f, ids[9]!)).statusCode).toBe(200);
    const r = await approveRun(f, ids[9]!);
    expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  });

  it('January reopened, February calculated and approved meanwhile, January re-approved unchanged: refused until recalculated, then warned', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4fu reopen then later month', 20_000);
    await setSalary(pool, f, 2027, 1, 60_000);
    const ids: string[] = [];
    for (const p of PERIODS.slice(0, 11)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); expect((await approveRun(f, id)).statusCode).toBe(200); ids.push(id); }
    const jan = ids[10]!;
    expect((await reopenRun(f, jan)).statusCode).toBe(200);
    // February, calculated while January is reopened (not declarable), leaves January out.
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    expect((await approveRun(f, feb)).statusCode).toBe(200);
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02.*Recalculate the run/);
    // Recalculated, January carries the warning naming February, and its approval goes through
    // (the journal it posted carries the same figures, so it is re-approved onto it).
    await calcOnly(f, jan);
    const codes = ((await runLine(pool, jan, f.employee)).validation_results as Array<{ code: string; message: string }>);
    expect(codes.find(c => c.code === 'PAYE_LATER_PERIODS_APPROVED')?.message).toMatch(/2027-02/);
    const reapproved = await approveRun(f, jan);
    expect(reapproved.statusCode, JSON.stringify(reapproved.body)).toBe(200);
  });

  it('December then January reopened and re-approved unchanged: January is approved (December was approved when January was calculated)', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4fu reopen chain', 20_000);
    const ids: string[] = [];
    for (const p of PERIODS.slice(0, 11)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); expect((await approveRun(f, id)).statusCode).toBe(200); ids.push(id); }
    expect((await reopenRun(f, ids[9]!)).statusCode).toBe(200);
    expect((await approveRun(f, ids[9]!)).statusCode).toBe(200);
    expect((await reopenRun(f, ids[10]!)).statusCode).toBe(200);
    const again = await approveRun(f, ids[10]!);
    expect(again.statusCode, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  });
});
